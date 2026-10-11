using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Nodes;

// Start-time authority and liveness are transient. The secret and Session receipts are durable.
internal sealed class RemoteExecAuthority
{
    internal sealed class Claim(string node, SessionOwner owner, string execId, string grant)
    {
        internal readonly string Node = node;
        internal readonly SessionOwner Owner = owner;
        internal readonly string OriginalSessionId = owner.Id;
        internal readonly string ExecId = execId;
        internal readonly string Grant = grant;
        internal string Agent = owner.Agent;
        internal string State = "reserved";
        internal DateTimeOffset TrackedAt = DateTimeOffset.UtcNow;
    }

    private readonly object gate = new();
    private readonly Dictionary<string, Claim> claims = new(StringComparer.Ordinal);
    private readonly byte[] secret;
    internal Func<string>? GenerateId { get; set; }

    internal RemoteExecAuthority(string root)
    {
        var file = Path.Combine(root, "state", "node_event_capability_secret");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        FileStream? created = null;
        try
        {
            created = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        }
        catch (IOException) when (File.Exists(file)) { }
        if (created is not null)
        {
            using (created)
            {
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                var bytes = Encoding.ASCII.GetBytes(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)) + "\n");
                created.Write(bytes);
                created.Flush(true);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(file)!);
            }
        }
        var text = File.ReadAllText(file).Trim();
        if (text.Length != 64 || !text.All(Uri.IsHexDigit))
            throw new InvalidDataException("Node event capability secret is malformed.");
        secret = Convert.FromHexString(text);
    }

    private static string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value) => Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
    private static string Key(string original, string id) => original + "\0" + id;

    internal string Issue(string node, string original, string id)
    {
        var payload = new JsonObject
        {
            ["v"] = 1,
            ["purpose"] = "remote-exec-completion",
            ["nodeId"] = node,
            ["sessionId"] = original,
            ["execId"] = id,
            ["issuedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        var encoded = Encode(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        return encoded + "." + Encode(HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(encoded)));
    }

    internal bool Verify(string node, string original, string id, string grant)
    {
        try
        {
            var parts = grant.Split('.');
            if (parts.Length != 2)
                return false;
            var signature = Decode(parts[1]);
            if (!CryptographicOperations.FixedTimeEquals(signature, HMACSHA256.HashData(secret, Encoding.ASCII.GetBytes(parts[0]))))
                return false;
            var payload = JsonNode.Parse(Decode(parts[0])) as JsonObject;
            return SessionWait.Number(payload?["v"]) == 1
                && SessionWait.Text(payload?["purpose"]) == "remote-exec-completion"
                && SessionWait.Text(payload?["nodeId"]) == node
                && SessionWait.Text(payload?["sessionId"]) == original
                && SessionWait.Text(payload?["execId"]) == id
                && SessionWait.Number(payload?["issuedAt"]) is double issued && double.IsFinite(issued);
        }
        catch (Exception error) when (error is FormatException or System.Text.Json.JsonException or ArgumentException)
        {
            return false;
        }
    }

    private void Prune()
    {
        foreach (var pair in claims.Where(pair => DateTimeOffset.UtcNow - pair.Value.TrackedAt > TimeSpan.FromHours(24)).ToArray())
            claims.Remove(pair.Key);
    }

    internal string NextId(bool legacy) => (legacy ? "exec_" : "") + (GenerateId?.Invoke()
        ?? ExecPetnames.Adjectives[RandomNumberGenerator.GetInt32(ExecPetnames.Adjectives.Length)] + "-" + ExecPetnames.Nouns[RandomNumberGenerator.GetInt32(ExecPetnames.Nouns.Length)]);

    internal Claim? Reserve(string node, SessionOwner owner, string id)
    {
        lock (gate)
        {
            Prune();
            if (claims.Values.Any(claim => ReferenceEquals(claim.Owner, owner) && claim.ExecId == id))
                return null;
            var claim = new Claim(node, owner, id, Issue(node, owner.Id, id));
            claims.Add(Key(claim.OriginalSessionId, id), claim);
            return claim;
        }
    }

    internal Claim? Exact(string node, string original, string id, string grant)
    {
        lock (gate)
        {
            Prune();
            return claims.TryGetValue(Key(original, id), out var claim)
                && claim.Node == node && claim.Grant == grant && Verify(node, original, id, grant) ? claim : null;
        }
    }

    internal bool Activate(string node, string original, string id, string grant, SessionOwner owner)
    {
        lock (gate)
        {
            var claim = Exact(node, original, id, grant);
            if (claim is null || !ReferenceEquals(claim.Owner, owner))
                return false;
            if (claim.State != "active")
            {
                claim.State = "active";
                claim.TrackedAt = DateTimeOffset.UtcNow;
            }
            return true;
        }
    }

    internal void Settle(Claim claim, bool definite)
    {
        lock (gate)
        {
            if (!ReferenceEquals(Exact(claim.Node, claim.OriginalSessionId, claim.ExecId, claim.Grant), claim) || claim.State == "active")
                return;
            if (definite)
                claims.Remove(Key(claim.OriginalSessionId, claim.ExecId));
            else
                claim.State = "outcome-unknown";
        }
    }

    internal void Complete(Claim claim)
    {
        lock (gate)
            if (ReferenceEquals(Exact(claim.Node, claim.OriginalSessionId, claim.ExecId, claim.Grant), claim))
                claims.Remove(Key(claim.OriginalSessionId, claim.ExecId));
    }

    internal bool Has(SessionOwner owner, string id, bool activeOnly = true)
    {
        lock (gate)
        {
            Prune();
            return claims.Values.Any(claim => ReferenceEquals(claim.Owner, owner) && claim.Agent == owner.Agent && claim.ExecId == id && (!activeOnly || claim.State == "active"));
        }
    }

    internal void Rebind(SessionOwner owner)
    {
        lock (gate)
            foreach (var claim in claims.Values.Where(claim => ReferenceEquals(claim.Owner, owner)))
                claim.Agent = owner.Agent;
    }

    internal void Retire(SessionOwner owner)
    {
        lock (gate)
            foreach (var pair in claims.Where(pair => ReferenceEquals(pair.Value.Owner, owner)).ToArray())
                claims.Remove(pair.Key);
    }

    internal void Clear()
    {
        lock (gate)
            claims.Clear();
    }
}
