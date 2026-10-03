using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>Persisted attachments only; no channel transport or invented binding from lastChannel.</summary>
internal sealed class SessionDeletionChannels(string root)
{
    private readonly object gate = new();
    private string FilePath => Path.Combine(root, "state", "channels.json");
    private string EvidencePath => Path.Combine(root, "state", "sessions.json.pre-catalog-sqlite-v1.bak");
    internal JsonObject Read(string? participant = null) { lock (gate) return ReadLocked(participant); }
    private JsonObject ReadLocked(string? participant, bool normalize = true, bool persistMigration = true)
    {
        if (ReadOptional(FilePath) is { } current) return Validate(current, normalize);
        if (ReadOptional(EvidencePath) is not { } evidence) return new JsonObject { ["channels"] = new JsonObject() };
        if (!evidence.ContainsKey("channelAttachments")) return new JsonObject { ["channels"] = new JsonObject() };
        if (evidence["channelAttachments"] is not JsonObject old) throw new InvalidDataException("Invalid selected legacy channel attachments.");
        var channels = new JsonObject();
        foreach (var (key, value) in old)
            channels[key] = value is JsonValue text && text.TryGetValue<string>(out var id)
                ? new JsonObject { ["sessionId"] = id } : value?.DeepClone();
        var result = Validate(new JsonObject { ["channels"] = channels }, normalize);
        if (persistMigration) { Barrier(participant, "migration-before-write"); Write(result); } return result;
    }
    private static JsonObject? ReadOptional(string file)
    {
        try { return JsonNode.Parse(File.ReadAllText(file)) as JsonObject ?? throw new InvalidDataException("Channel authority must be an object."); }
        catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
    }
    private static JsonObject Validate(JsonObject payload, bool normalize = true)
    {
        if (payload["channels"] is not JsonObject channels) throw new InvalidDataException("Channel authority requires a channels map.");
        foreach (var (key, value) in channels)
        {
            var colon = key.IndexOf(':');
            if (colon <= 0 || colon == key.Length - 1 || value is not JsonObject config || SessionCatalog.Text(config["sessionId"]) is not { Length: > 0 })
                throw new InvalidDataException("Channel authority contains an invalid binding.");
            if (config["mode"] is not null && SessionCatalog.Text(config["mode"]) is not ("send-only" or "push-only"))
                throw new InvalidDataException("Channel authority contains an unsupported mode.");
            if (normalize && SessionCatalog.Text(config["mode"]) == "push-only") config["mode"] = "send-only";
            if (normalize && !config.ContainsKey("dangerouslyAllowAllUsers") && config.ContainsKey("dangerouslyAllowAllGroupMembers"))
                config["dangerouslyAllowAllUsers"] = config["dangerouslyAllowAllGroupMembers"]?.DeepClone();
            foreach (var flag in new[] { "dangerouslyAllowAllUsers", "dangerouslyAllowAllGroupMembers" })
                if (config[flag] is not null && (config[flag] is not JsonValue scalar || !scalar.TryGetValue<bool>(out _)))
                    throw new InvalidDataException("Channel authority contains an invalid user flag.");
        }
        return payload;
    }
    internal JsonArray Blockers(JsonObject payload, IEnumerable<string> ids)
    {
        var selected = ids.ToHashSet(StringComparer.Ordinal); var result = new JsonArray();
        foreach (var (key, value) in payload["channels"]!.AsObject())
        {
            var id = SessionCatalog.Text(value!["sessionId"])!; var colon = key.IndexOf(':');
            if (selected.Contains(id) && key[..colon] != "webui") result.Add(new JsonObject
            { ["sessionId"] = id, ["channelId"] = key[..colon], ["conversationId"] = key[(colon + 1)..] });
        }
        return result;
    }
    internal void ValidateIdentityAuthority() { lock (gate) _ = ReadLocked("identity", normalize: false, persistMigration: false); }
    internal void RewriteIdentity(string from, string to)
    {
        lock (gate)
        {
            var payload = ReadLocked(from, normalize: false); Barrier(from, "identity-after-read"); var changed = false;
            foreach (var (_, value) in payload["channels"]!.AsObject())
                if (SessionCatalog.Text(value?["sessionId"]) == from) { value!["sessionId"] = to; changed = true; }
            if (changed) Write(payload);
        }
    }
    internal void Detach(string id) { lock (gate) DetachLocked(id); }
    private void DetachLocked(string id)
    {
        var payload = ReadLocked(id); Barrier(id, "after-read"); var channels = payload["channels"]!.AsObject();
        var keys = channels.Where(pair => SessionCatalog.Text(pair.Value?["sessionId"]) == id).Select(pair => pair.Key).ToArray();
        if (keys.Any(key => !key.StartsWith("webui:", StringComparison.Ordinal))) throw new InvalidDataException("Non-WebUI binding appeared before deletion cleanup.");
        if (keys.Length == 0) { if (ReadOptional(FilePath) is not null) LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!); return; }
        foreach (var key in keys) channels.Remove(key);
        Write(payload);
    }
    private void Barrier(string? participant, string stage)
    {
        if (participant is null) return;
        var hold = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(participant) + ".channels-" + stage + "-hold");
        if (!File.Exists(hold)) return;
        File.WriteAllText(hold + ".reached", "reached"); var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(hold) && DateTime.UtcNow < deadline) Thread.Sleep(2);
        if (File.Exists(hold)) throw new TimeoutException("Experimental channel publication barrier expired.");
    }
    private void Write(JsonObject payload)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temp = FilePath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(Encoding.UTF8.GetBytes(payload.ToJsonString())); stream.Flush(true); }
            File.Move(temp, FilePath, true); LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
        }
        finally { File.Delete(temp); }
    }
}
