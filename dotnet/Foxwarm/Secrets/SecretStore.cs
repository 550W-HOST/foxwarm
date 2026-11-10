using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Secrets;

internal sealed record SecretMetadata(
    string Name,
    string Description,
    bool IsSet,
    bool Redactable,
    long CreatedAt,
    long UpdatedAt,
    long? SetAt,
    int RetiredVersions,
    long? RetainedUntil,
    // The Agent that owns the secret; null when it belongs to the instance.
    string? Owner = null
);

internal sealed class SecretStoreLockedException(string message, Exception? inner = null)
    : InvalidOperationException(message, inner);

// Main-only encrypted, write-only store. Values are readable only through Resolve, which
// serves configuration sinks and the redactor; no route or tool returns them.
internal sealed partial class SecretStore
{
    internal const int MinimumRedactableLength = 12;
    internal const string KeyUnavailableMessage =
        "The secret store is locked: the instance key is unavailable.";
    internal const string UnreadableMessage =
        "The secret store is locked: its file cannot be read.";
    internal const int MaximumValueBytes = 64 * 1024;
    internal static readonly TimeSpan RetiredRetention = TimeSpan.FromDays(90);

    [GeneratedRegex("^[a-z0-9][a-z0-9._-]{0,63}$", RegexOptions.CultureInvariant)]
    internal static partial Regex NamePattern();

    private readonly string path;
    private readonly Func<InstanceKeys> keys;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private JsonObject? document;
    private byte[]? encryptionKey;
    private string? keyId;

    // Decrypted values keyed by their unique nonce, so a reused name never sees stale text.
    private readonly Dictionary<string, string> plaintext = new(StringComparer.Ordinal);
    private long generation = 1;

    internal SecretStore(string path, Func<InstanceKeys> keys, TimeProvider? clock = null)
    {
        this.path = Path.GetFullPath(path);
        this.keys = keys;
        this.clock = clock ?? TimeProvider.System;
    }

    internal string FilePath => path;

    // Changes on every value or metadata change; consumers re-resolve when it moves.
    internal long Generation => Interlocked.Read(ref generation);

    internal event Action? Changed;

    internal static void ValidateName(string name)
    {
        if (!NamePattern().IsMatch(name))
            throw new InvalidDataException(
                "Secret names use 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit."
            );
    }

    internal IReadOnlyList<SecretMetadata> List()
    {
        lock (gate)
        {
            var now = Now();
            return Entries()
                .Select(pair => Metadata(pair.Key, pair.Value, now))
                .OrderBy(item => item.Name, StringComparer.Ordinal)
                .ToArray();
        }
    }

    internal bool Contains(string name)
    {
        lock (gate)
            return Entries()[name] is JsonObject entry && Current(entry) is not null;
    }

    // Returns null when the name has no current value. Throws when the store is locked.
    internal string? Resolve(string name)
    {
        lock (gate)
        {
            if (Entries()[name] is not JsonObject entry || Current(entry) is not JsonObject current)
                return null;
            return Decrypt(name, current);
        }
    }

    // Current values and retired values still within retention, for redaction only.
    internal IReadOnlyList<(string Name, string Value)> RedactionValues()
    {
        lock (gate)
        {
            var now = Now();
            var values = new List<(string, string)>();
            foreach (var (name, node) in Entries())
            foreach (var version in Versions(node!.AsObject()))
            {
                if (
                    SessionWait.Text(version["state"]) == "retired"
                    && (SessionWait.Number(version["redactUntil"]) ?? 0) <= now
                )
                    continue;
                values.Add((name, Decrypt(name, version)));
            }
            return values;
        }
    }

    // The Agent that owns a secret, or null for the instance and for unknown names.
    internal string? Owner(string name)
    {
        lock (gate)
            return Entries()[name] is JsonObject entry ? OwnerOf(entry) : null;
    }

    // Sets the current value. A new name belongs to the instance; an existing one keeps its owner.
    internal SecretMetadata Set(string name, string value, string? description = null) =>
        Store(name, value, description, create: false, owner: null);

    // Adds a value under a name that has none. A name whose values were all retired is reused
    // and takes the new owner. ownerAgent null means the instance.
    internal SecretMetadata Create(
        string name,
        string value,
        string? description,
        string? ownerAgent
    ) => Store(name, value, description, create: true, owner: ownerAgent);

    // Hands every secret an Agent owns to the instance, so a later Agent with the same name
    // does not inherit them. Returns the affected names.
    internal IReadOnlyList<string> TransferToInstance(string agent)
    {
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            var moved = new List<string>();
            var now = Now();
            foreach (var (name, node) in next["entries"]!.AsObject())
                if (node is JsonObject entry && OwnerOf(entry) == agent)
                {
                    entry["owner"] = new JsonObject { ["kind"] = "instance" };
                    entry["updatedAt"] = now;
                    moved.Add(name);
                }
            if (moved.Count > 0)
                Commit(next);
            return moved;
        }
    }

    private SecretMetadata Store(
        string name,
        string value,
        string? description,
        bool create,
        string? owner
    )
    {
        ValidateName(name);
        if (string.IsNullOrEmpty(value))
            throw new InvalidDataException("A secret value is required.");
        if (value.Contains('\0') || Encoding.UTF8.GetByteCount(value) > MaximumValueBytes)
            throw new InvalidDataException(
                "Secret values must be at most 64 KiB and must not contain NUL characters."
            );
        description = NormalizeDescription(description);
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            var entries = next["entries"]!.AsObject();
            var now = Now();
            var entry = entries[name] as JsonObject;
            if (create && entry is not null && Current(entry) is not null)
                throw new InvalidOperationException($"Secret `{name}` already exists.");
            if (entry is null)
                entries[name] = entry = new JsonObject
                {
                    ["description"] = description ?? "",
                    ["createdAt"] = now,
                    ["versions"] = new JsonArray(),
                };
            else if (create || description is not null)
                entry["description"] = description ?? "";
            if (create || entry["owner"] is null)
                entry["owner"] = OwnerNode(owner);
            var versions = entry["versions"]!.AsArray();
            var number =
                versions
                    .Select(version => (int)(SessionWait.Number(version?["version"]) ?? 0))
                    .DefaultIfEmpty(0)
                    .Max() + 1;
            foreach (var version in versions.OfType<JsonObject>())
                if (SessionWait.Text(version["state"]) == "current")
                    Retire(version, now);
            var sealedValue = Encrypt(name, number, value);
            versions.Insert(
                0,
                new JsonObject
                {
                    ["version"] = number,
                    ["state"] = "current",
                    ["setAt"] = now,
                    ["redactable"] = value.Length >= MinimumRedactableLength,
                    ["nonce"] = sealedValue.Nonce,
                    ["ciphertext"] = sealedValue.Ciphertext,
                }
            );
            entry["updatedAt"] = now;
            Commit(next);
            plaintext[sealedValue.Nonce] = value;
            return Metadata(name, entry, now);
        }
    }

    internal SecretMetadata Describe(string name, string description)
    {
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            if (next["entries"]![name] is not JsonObject entry)
                throw new KeyNotFoundException("Secret is not defined: " + name);
            entry["description"] = NormalizeDescription(description) ?? "";
            entry["updatedAt"] = Now();
            Commit(next);
            return Metadata(name, entry, Now());
        }
    }

    // Removes a value created moments ago that was never used, such as a secret answer whose
    // message was not admitted. Unlike Delete it keeps nothing; earlier retired values stay.
    internal void Withdraw(string name)
    {
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            if (next["entries"]![name] is not JsonObject entry)
                return;
            var versions = entry["versions"]!.AsArray();
            foreach (
                var current in versions
                    .OfType<JsonObject>()
                    .Where(version => SessionWait.Text(version["state"]) == "current")
                    .ToArray()
            )
                versions.Remove(current);
            entry["updatedAt"] = Now();
            if (versions.Count == 0)
                next["entries"]!.AsObject().Remove(name);
            Commit(next);
        }
    }

    // Deleting retires the current value for the retention period, so text that already
    // carries it remains masked. The name stays listed until its retired values expire.
    internal void Delete(string name)
    {
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            if (next["entries"]![name] is not JsonObject entry)
                throw new KeyNotFoundException("Secret is not defined: " + name);
            var now = Now();
            foreach (var version in Versions(entry))
                if (SessionWait.Text(version["state"]) == "current")
                    Retire(version, now);
            entry["updatedAt"] = now;
            Prune(next, now);
            Commit(next);
        }
    }

    internal void ForgetRetired(string name)
    {
        lock (gate)
        {
            var next = (JsonObject)Load().DeepClone();
            if (next["entries"]![name] is not JsonObject entry)
                throw new KeyNotFoundException("Secret is not defined: " + name);
            var versions = entry["versions"]!.AsArray();
            foreach (
                var retired in versions
                    .OfType<JsonObject>()
                    .Where(version => SessionWait.Text(version["state"]) == "retired")
                    .ToArray()
            )
                versions.Remove(retired);
            entry["updatedAt"] = Now();
            if (versions.Count == 0)
                next["entries"]!.AsObject().Remove(name);
            Commit(next);
        }
    }

    internal static string? NormalizeDescription(string? description)
    {
        if (description is null)
            return null;
        description = description.Trim();
        if (description.Length > 500 || description.IndexOfAny(['\r', '\n', '\0']) >= 0)
            throw new InvalidDataException(
                "Descriptions are single-line text up to 500 characters."
            );
        return description;
    }

    private static void Retire(JsonObject version, long now)
    {
        version["state"] = "retired";
        version["retiredAt"] = now;
        version["redactUntil"] = now + (long)RetiredRetention.TotalMilliseconds;
    }

    private static IEnumerable<JsonObject> Versions(JsonObject entry) =>
        (entry["versions"] as JsonArray ?? []).OfType<JsonObject>();

    private static JsonObject? Current(JsonObject entry) =>
        Versions(entry).FirstOrDefault(version => SessionWait.Text(version["state"]) == "current");

    private SecretMetadata Metadata(string name, JsonNode? node, long now)
    {
        var entry = node!.AsObject();
        var current = Current(entry);
        var retained = Versions(entry)
            .Where(version =>
                SessionWait.Text(version["state"]) == "retired"
                && (SessionWait.Number(version["redactUntil"]) ?? 0) > now
            )
            .ToArray();
        return new SecretMetadata(
            name,
            SessionWait.Text(entry["description"]) ?? "",
            current is not null,
            current?["redactable"]?.GetValue<bool>() != false,
            (long)(SessionWait.Number(entry["createdAt"]) ?? 0),
            (long)(SessionWait.Number(entry["updatedAt"]) ?? 0),
            current is null ? null : (long?)SessionWait.Number(current["setAt"]),
            retained.Length,
            retained.Length == 0
                ? null
                : retained.Max(version => (long)(SessionWait.Number(version["redactUntil"]) ?? 0)),
            OwnerOf(entry)
        );
    }

    private static JsonObject OwnerNode(string? agent) =>
        agent is null
            ? new JsonObject { ["kind"] = "instance" }
            : new JsonObject { ["kind"] = "agent", ["agent"] = agent };

    // Entries written before ownership existed, and any owner this version does not
    // recognize, belong to the instance: they grant no Agent anything.
    private static string? OwnerOf(JsonObject entry) =>
        entry["owner"] is JsonObject owner
        && SessionWait.Text(owner["kind"]) == "agent"
        && SessionWait.Text(owner["agent"]) is { Length: > 0 } agent
            ? agent
            : null;

    private JsonObject Entries() => Load()["entries"]!.AsObject();

    // Throws SecretStoreLockedException when the store file cannot be used.
    internal void Check()
    {
        lock (gate)
            _ = Load();
    }

    // An unreadable, malformed or newer-version store is treated like a missing key: every
    // consumer fails on its own and nothing overwrites the file. Reading is retried on the
    // next use, so repairing or restoring the file needs no restart.
    private JsonObject Read()
    {
        JsonObject loaded;
        try
        {
            loaded =
                JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) as JsonObject
                ?? throw new InvalidDataException();
        }
        catch (Exception error)
            when (error
                    is System.Text.Json.JsonException
                        or InvalidDataException
                        or IOException
                        or UnauthorizedAccessException
            )
        {
            throw new SecretStoreLockedException(UnreadableMessage, error);
        }
        if (SessionWait.Number(loaded["version"]) is not 1)
            throw new SecretStoreLockedException(
                SessionWait.Number(loaded["version"]) is > 1
                    ? "The secret store is locked: it was written by a newer Foxwarm version."
                    : "The secret store is locked: its file is malformed."
            );
        if (
            loaded["entries"] is not JsonObject entries
            || entries.Any(pair =>
                !NamePattern().IsMatch(pair.Key)
                || pair.Value is not JsonObject value
                || value["versions"] is not JsonArray
            )
        )
            throw new SecretStoreLockedException(
                "The secret store is locked: its file is malformed."
            );
        return loaded;
    }

    private long Now() => clock.GetUtcNow().ToUnixTimeMilliseconds();

    private JsonObject Load()
    {
        if (document is not null)
            return document;
        JsonObject loaded;
        if (File.Exists(path))
            loaded = Read();
        else
            loaded = new JsonObject { ["version"] = 1, ["entries"] = new JsonObject() };
        document = loaded;
        if (Prune(loaded, Now()) && File.Exists(path))
        {
            // Expired retired values are removed from disk at the next opportunity.
            try
            {
                Persist(loaded);
            }
            catch (Exception error) when (error is IOException or SecretStoreLockedException) { }
        }
        return loaded;
    }

    private static bool Prune(JsonObject root, long now)
    {
        var changed = false;
        var entries = root["entries"]!.AsObject();
        foreach (var (name, node) in entries.ToArray())
        {
            var versions = node!["versions"]!.AsArray();
            foreach (
                var expired in versions
                    .OfType<JsonObject>()
                    .Where(version =>
                        SessionWait.Text(version["state"]) == "retired"
                        && (SessionWait.Number(version["redactUntil"]) ?? 0) <= now
                    )
                    .ToArray()
            )
            {
                versions.Remove(expired);
                changed = true;
            }
            if (versions.Count == 0)
            {
                entries.Remove(name);
                changed = true;
            }
        }
        return changed;
    }

    private void Commit(JsonObject next)
    {
        Persist(next);
        document = next;
        var live = next["entries"]!
            .AsObject()
            .SelectMany(pair => Versions(pair.Value!.AsObject()))
            .Select(version => SessionWait.Text(version["nonce"]) ?? "")
            .ToHashSet(StringComparer.Ordinal);
        foreach (var nonce in plaintext.Keys.Where(nonce => !live.Contains(nonce)).ToArray())
            plaintext.Remove(nonce);
        Interlocked.Increment(ref generation);
        Changed?.Invoke();
    }

    private void Persist(JsonObject next)
    {
        if (next["keyId"] is null)
            next["keyId"] = EnsureKey().Id;
        new LinuxAtomicJsonFile(
            Path.GetDirectoryName(path)!,
            Path.GetFileName(path),
            privateFile: true
        ).WritePayload(next);
    }

    private (byte[] Key, string Id) EnsureKey()
    {
        if (encryptionKey is not null)
            return (encryptionKey, keyId!);
        InstanceKeys opened;
        try
        {
            opened = keys();
        }
        catch (Exception error)
            when (error is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            throw new SecretStoreLockedException(KeyUnavailableMessage, error);
        }
        var stored = SessionWait.Text(Load()["keyId"]);
        if (stored is not null && stored != opened.KeyId)
            throw new SecretStoreLockedException(
                "The secret store is locked: it was written with a different instance key."
            );
        encryptionKey = opened.Derive(InstanceKeys.SecretStorePurpose);
        keyId = opened.KeyId;
        return (encryptionKey, keyId);
    }

    private static byte[] AssociatedData(string name, int version, string keyId) =>
        Encoding.UTF8.GetBytes(name + "\0" + version + "\0" + keyId);

    private (string Nonce, string Ciphertext) Encrypt(string name, int version, string value)
    {
        var (key, id) = EnsureKey();
        var nonce = RandomNumberGenerator.GetBytes(12);
        var input = Encoding.UTF8.GetBytes(value);
        var output = new byte[input.Length + 16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(
            nonce,
            input,
            output.AsSpan(0, input.Length),
            output.AsSpan(input.Length),
            AssociatedData(name, version, id)
        );
        return (Convert.ToBase64String(nonce), Convert.ToBase64String(output));
    }

    private string Decrypt(string name, JsonObject version)
    {
        var number = (int)(SessionWait.Number(version["version"]) ?? 0);
        var nonceText = SessionWait.Text(version["nonce"]) ?? "";
        if (plaintext.TryGetValue(nonceText, out var cached))
            return cached;
        var (key, id) = EnsureKey();
        try
        {
            var nonce = Convert.FromBase64String(nonceText);
            var sealedValue = Convert.FromBase64String(
                SessionWait.Text(version["ciphertext"]) ?? ""
            );
            if (nonce.Length != 12 || sealedValue.Length < 16)
                throw new CryptographicException();
            var output = new byte[sealedValue.Length - 16];
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(
                nonce,
                sealedValue.AsSpan(0, output.Length),
                sealedValue.AsSpan(output.Length),
                output,
                AssociatedData(name, number, id)
            );
            var value = Encoding.UTF8.GetString(output);
            plaintext[nonceText] = value;
            return value;
        }
        catch (Exception error) when (error is CryptographicException or FormatException)
        {
            throw new SecretStoreLockedException(
                "The secret store is locked: secret `" + name + "` cannot be decrypted.",
                error
            );
        }
    }
}
