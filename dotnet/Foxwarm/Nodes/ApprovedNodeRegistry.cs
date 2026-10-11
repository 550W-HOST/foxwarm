using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

// This registry records trust in existing environments, not environment ownership.
internal sealed class ApprovedNodeRegistry
{
    internal const long PairingTtl = 60 * 60 * 1000;
    private readonly object gate = new();
    private readonly LinuxAtomicJsonFile file;
    private JsonObject data;
    internal string PairingToken { get; }
    internal event Action<string>? Expired;
    internal static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    internal ApprovedNodeRegistry(string root)
    {
        file = new(root, "state/nodes.json");
        data = Load();
        var tokenPath = Path.Combine(root, "state", "node_token");
        Directory.CreateDirectory(Path.GetDirectoryName(tokenPath)!);
        if (!File.Exists(tokenPath))
        {
            File.WriteAllText(tokenPath, Token());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(tokenPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        PairingToken = File.ReadAllText(tokenPath, new UTF8Encoding(false, true)).Trim();
        if (PairingToken.Length == 0) throw new InvalidDataException("Node pairing token is empty.");
        Cleanup();
    }

    private JsonObject Load()
    {
        var candidates = new[] { file.FilePath, file.FilePath + ".1.bak", file.FilePath + ".2.bak", file.FilePath + ".3.bak", file.FilePath + ".bak" };
        Exception? failure = null;
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            try
            {
                var loaded = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? throw new InvalidDataException("Invalid Node registry.");
                loaded["approvedNodes"] = loaded["approvedNodes"] is JsonObject approved ? approved.DeepClone() : new JsonObject();
                loaded["pendingPairings"] = loaded["pendingPairings"] is JsonObject pending ? pending.DeepClone() : new JsonObject();
                foreach (var value in loaded["pendingPairings"]!.AsObject().Select(pair => pair.Value).OfType<JsonObject>()) value.Remove("pairCode");
                if (path != file.FilePath) file.WritePayload(loaded);
                return loaded;
            }
            catch (Exception error) when (error is IOException or System.Text.Json.JsonException) { failure = error; }
        }
        if (failure is not null) throw new InvalidDataException("Node registry and its backups cannot be read.", failure);
        return new() { ["approvedNodes"] = new JsonObject(), ["pendingPairings"] = new JsonObject() };
    }

    private T Change<T>(Func<JsonObject, T> apply)
    {
        lock (gate)
        {
            var next = (JsonObject)data.DeepClone();
            var result = apply(next);
            try { file.WritePayload(next); }
            catch (AuthorityCommittedException) { data = next; throw; }
            data = next;
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(file.FilePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            return result;
        }
    }

    private static JsonObject Approved(JsonObject document) => document["approvedNodes"]!.AsObject();
    private static JsonObject Pending(JsonObject document) => document["pendingPairings"]!.AsObject();
    private static string Token() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
    internal static bool Equal(string a, string b) => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    internal static string ValidateId(string id, bool newId = false)
    {
        id = id.Trim();
        if (!Regex.IsMatch(id, "^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant) || id.Equals("master", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Node id must use letters, numbers, hyphens or underscores and cannot be master.");
        if (newId && Slug(id) != id) throw new InvalidDataException("Node id must already be in sanitized form: " + Slug(id));
        return id;
    }
    private static string Slug(string value)
    {
        var slug = Regex.Replace(Regex.Replace(value.Trim().ToLowerInvariant(), "[^a-z0-9_-]+", "-"), "-+", "-").Trim('-');
        if (slug.Length > 48) slug = slug[..48];
        return slug.Length == 0 ? "node" : slug;
    }
    private static JsonObject Safe(JsonObject record)
    {
        var copy = (JsonObject)record.DeepClone();
        copy.Remove("tokenHash");
        copy.Remove("approvedAuthToken");
        return copy;
    }
    internal JsonArray ListApproved()
    {
        Cleanup();
        lock (gate) return new(Approved(data).OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => (JsonNode?)Safe(pair.Value!.AsObject())).ToArray());
    }
    internal JsonArray ListPending()
    {
        Cleanup();
        lock (gate) return new(Pending(data).Select(pair => pair.Value!.AsObject()).OrderBy(value => SessionWait.Number(value["requestedAt"])).Select(value => (JsonNode?)Safe(value)).ToArray());
    }
    internal bool Authenticate(string id, string auth)
    {
        Cleanup();
        lock (gate) return Approved(data)[id] is JsonObject record && Equal(SessionWait.Text(record["tokenHash"]) ?? "", Hash(auth));
    }
    internal JsonObject Create(string id)
    {
        id = ValidateId(id, true);
        Cleanup();
        return Change(next =>
        {
            if (Approved(next).ContainsKey(id)) throw new InvalidDataException("Node id already exists.");
            var auth = Token();
            Approved(next)[id] = new JsonObject { ["nodeId"] = id, ["nodeType"] = "cli-node", ["displayName"] = id, ["tokenHash"] = Hash(auth), ["createdAt"] = Now, ["updatedAt"] = Now };
            return new JsonObject { ["nodeId"] = id, ["authToken"] = auth };
        });
    }
    internal JsonObject Request(JsonObject input, JsonObject protocol)
    {
        Cleanup();
        return Change(next =>
        {
            var record = new JsonObject { ["id"] = "pair_" + Now + "_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(), ["requestedName"] = input["requestedName"]?.DeepClone(), ["nodeType"] = input["nodeType"]!.DeepClone(), ["capabilities"] = input["capabilities"]!.DeepClone(), ["nodeProtocol"] = protocol["client"]!.DeepClone(), ["legacyProtocol"] = protocol["legacyClient"]!.DeepClone(), ["requestedAt"] = Now, ["updatedAt"] = Now };
            Pending(next)[record["id"]!.GetValue<string>()] = record;
            return Safe(record);
        });
    }
    internal JsonObject Approve(string pendingId, string? id)
    {
        Cleanup();
        return Change(next =>
        {
            var pending = Pending(next)[pendingId] as JsonObject ?? throw new InvalidDataException("Pending pairing not found.");
            if (pending["approvedNodeId"] is not null) throw new InvalidDataException("Pairing is no longer awaiting approval.");
            if (!string.IsNullOrWhiteSpace(id)) id = ValidateId(id);
            else
            {
                var basis = Slug(SessionWait.Text(pending["requestedName"]) ?? SessionWait.Text(pending["nodeType"]) ?? "node");
                if (basis == "master") basis = "master-node";
                id = basis;
                for (var suffix = 2; Approved(next).ContainsKey(id); suffix++) id = basis + "-" + suffix;
            }
            if (Approved(next).ContainsKey(id)) throw new InvalidDataException("Node id already exists.");
            var auth = Token();
            Approved(next)[id] = new JsonObject { ["nodeId"] = id, ["nodeType"] = pending["nodeType"]!.DeepClone(), ["requestedName"] = pending["requestedName"]?.DeepClone(), ["displayName"] = pending["requestedName"]?.DeepClone() ?? JsonValue.Create(id), ["tokenHash"] = Hash(auth), ["createdAt"] = Now, ["updatedAt"] = Now, ["capabilities"] = pending["capabilities"]!.DeepClone(), ["nodeProtocol"] = pending["nodeProtocol"]!.DeepClone() };
            pending["approvedNodeId"] = id;
            pending["approvedAuthToken"] = auth;
            pending["approvedAt"] = Now;
            pending["updatedAt"] = Now;
            return new JsonObject { ["nodeId"] = id, ["authToken"] = auth, ["pendingId"] = pendingId };
        });
    }
    internal JsonObject? Claim(string nodeType, string? name)
    {
        Cleanup();
        lock (gate)
        {
            var match = Pending(data).FirstOrDefault(pair => pair.Value is JsonObject record && record["approvedAuthToken"] is not null && SessionWait.Text(record["nodeType"]) == nodeType && SessionWait.Text(record["requestedName"]) == name);
            return match.Key is null ? null : ClaimId(match.Key);
        }
    }
    internal JsonObject? ClaimId(string id) => Change(next =>
    {
        if (Pending(next)[id] is not JsonObject record || record["approvedAuthToken"] is null) return null;
        var result = new JsonObject { ["nodeId"] = record["approvedNodeId"]!.DeepClone(), ["authToken"] = record["approvedAuthToken"]!.DeepClone(), ["pendingId"] = id };
        Pending(next).Remove(id);
        return result;
    });
    internal void Reject(string pendingId) => Change(next =>
    {
        if (Pending(next)[pendingId] is not JsonObject record) throw new InvalidDataException("Pending pairing not found.");
        if (SessionWait.Text(record["approvedNodeId"]) is string approved) Approved(next).Remove(approved);
        Pending(next).Remove(pendingId);
        return true;
    });
    internal void Remove(string id) => Change(next =>
    {
        ValidateId(id);
        if (!Approved(next).Remove(id)) throw new InvalidDataException("Approved Node not found.");
        foreach (var pair in Pending(next).ToArray()) if (SessionWait.Text(pair.Value?["approvedNodeId"]) == id) Pending(next).Remove(pair.Key);
        return true;
    });
    internal void Rename(string oldId, string newId) => Change(next =>
    {
        ValidateId(oldId); ValidateId(newId, true);
        var record = Approved(next)[oldId] as JsonObject ?? throw new InvalidDataException("Approved Node not found.");
        if (Approved(next).ContainsKey(newId)) throw new InvalidDataException("Node id already exists.");
        var moved = (JsonObject)record.DeepClone();
        moved["nodeId"] = newId;
        if (SessionWait.Text(moved["displayName"]) == oldId) moved["displayName"] = newId;
        moved["updatedAt"] = Now;
        Approved(next).Remove(oldId); Approved(next)[newId] = moved;
        foreach (var value in Pending(next).Select(pair => pair.Value).OfType<JsonObject>()) if (SessionWait.Text(value["approvedNodeId"]) == oldId) value["approvedNodeId"] = newId;
        return true;
    });
    internal void Touch(string id, string auth, JsonObject input, JsonObject compatibility) => Change(next =>
    {
        var record = Approved(next)[id] as JsonObject ?? throw new InvalidDataException("Node credentials were removed.");
        if (!Equal(SessionWait.Text(record["tokenHash"]) ?? "", Hash(auth))) throw new InvalidDataException("Node credentials were replaced.");
        record["nodeType"] = input["nodeType"]!.DeepClone(); record["capabilities"] = input["capabilities"]!.DeepClone();
        record["nodeProtocol"] = compatibility["client"]!.DeepClone(); record["protocolCompatibility"] = compatibility.DeepClone();
        record["lastSeenAt"] = Now; record["updatedAt"] = Now;
        return true;
    });
    internal void Cleanup(long? timestamp = null)
    {
        lock (gate)
        {
            var now = timestamp ?? Now;
            var ids = Pending(data).Where(pair => pair.Value is JsonObject value && SessionWait.Number(value["approvedAt"] ?? value["requestedAt"] ?? value["updatedAt"]) is double start && start > 0 && now - start > PairingTtl).Select(pair => pair.Key).ToArray();
            if (ids.Length == 0) return;
            Change(next => { foreach (var id in ids) { var record = Pending(next)[id]!; if (SessionWait.Text(record["approvedNodeId"]) is string approved) Approved(next).Remove(approved); Pending(next).Remove(id); } return true; });
            foreach (var id in ids) Expired?.Invoke(id);
        }
    }
}
