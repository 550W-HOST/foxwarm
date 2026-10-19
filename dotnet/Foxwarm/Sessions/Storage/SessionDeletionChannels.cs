using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>Persisted attachments only; no channel transport or invented binding from lastChannel.</summary>
internal sealed class SessionDeletionChannels(string root)
{
    private readonly object gate = new();
    private JsonObject? pendingOrdinary;
    private string FilePath => Path.Combine(root, "state", "channels.json");
    private string EvidencePath =>
        Path.Combine(root, "state", "sessions.json.pre-catalog-sqlite-v1.bak");

    internal JsonObject Read(string? participant = null)
    {
        lock (gate)
            return ReadLocked(participant);
    }

    internal JsonObject ReadForDelivery()
    {
        lock (gate)
            return ReadLocked(null, persistMigration: false);
    }

    internal void Attach(string destination, string id)
    {
        lock (gate)
        {
            var payload = ReadLocked(id);
            var channels = payload["channels"]!.AsObject();
            if (SessionCatalog.Text(channels[destination]?["sessionId"]) == id)
                return;
            var config = channels[destination] as JsonObject ?? new JsonObject();
            config["sessionId"] = id;
            if (config.Parent is null)
                channels[destination] = config;
            Barrier(id, "attach-before-write");
            Write(payload);
        }
    }

    internal JsonObject? Binding(string destination) =>
        ReadForDelivery()["channels"]?[destination] is JsonObject binding
            ? (JsonObject)binding.DeepClone()
            : null;

    internal void Bind(
        string destination,
        string id,
        JsonObject? updates = null,
        bool durable = true
    )
    {
        lock (gate)
        {
            var payload = ReadLocked(id);
            var before = (JsonObject)payload.DeepClone();
            var config = new JsonObject { ["sessionId"] = id };
            if (updates is not null)
                foreach (var (key, value) in updates)
                    config[key] = value?.DeepClone();
            payload["channels"]![destination] = config;
            try
            {
                PersistMutation(payload, durable);
            }
            catch
            {
                // Critical binding restores the prior live map even if replacement already happened.
                // The caller still receives the real persistence error; this is not a cross-file transaction.
                pendingOrdinary = before;
                throw;
            }
        }
    }

    internal void MutateBinding(string destination, string? field = null, JsonNode? value = null)
    {
        lock (gate)
        {
            var payload = ReadLocked(null);
            var channels = payload["channels"]!.AsObject();
            if (field is null)
                channels.Remove(destination);
            else
            {
                var config =
                    channels[destination] as JsonObject
                    ?? throw new InvalidOperationException(
                        "Channel " + destination + " not attached"
                    );
                if (value is null)
                    config.Remove(field);
                else
                    config[field] = value.DeepClone();
            }
            PersistMutation(payload, durable: false);
        }
    }

    private void PersistMutation(JsonObject payload, bool durable)
    {
        foreach (var (_, node) in payload["channels"]!.AsObject())
        {
            var config = node!.AsObject();
            config.Remove("dangerouslyAllowAllGroupMembers");
            foreach (
                var key in config
                    .Select(pair => pair.Key)
                    .Where(key => key is not ("sessionId" or "mode" or "dangerouslyAllowAllUsers"))
                    .ToArray()
            )
                config.Remove(key);
        }
        try
        {
            Write(payload);
        }
        catch (Exception error)
            when (!durable && error is IOException or UnauthorizedAccessException)
        {
            pendingOrdinary = payload;
            Console.Error.WriteLine("Channel attachment save failed: " + error.Message);
        }
    }

    private JsonObject ReadLocked(
        string? participant,
        bool normalize = true,
        bool persistMigration = true
    )
    {
        if (pendingOrdinary is not null)
            return (JsonObject)pendingOrdinary.DeepClone();
        if (ReadOptional(FilePath) is { } current)
            return Validate(current, normalize);
        if (ReadOptional(EvidencePath) is not { } evidence)
            return new JsonObject { ["channels"] = new JsonObject() };
        if (!evidence.ContainsKey("channelAttachments"))
            return new JsonObject { ["channels"] = new JsonObject() };
        if (evidence["channelAttachments"] is not JsonObject old)
            throw new InvalidDataException("Invalid selected legacy channel attachments.");
        var channels = new JsonObject();
        foreach (var (key, value) in old)
            channels[key] =
                value is JsonValue text && text.TryGetValue<string>(out var id)
                    ? new JsonObject { ["sessionId"] = id }
                    : value?.DeepClone();
        var result = Validate(new JsonObject { ["channels"] = channels }, normalize);
        if (persistMigration)
        {
            Barrier(participant, "migration-before-write");
            Write(result);
        }
        return result;
    }

    private static JsonObject? ReadOptional(string file)
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(file)) as JsonObject
                ?? throw new InvalidDataException("Channel authority must be an object.");
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
    }

    private static JsonObject Validate(JsonObject payload, bool normalize = true)
    {
        if (payload["channels"] is not JsonObject channels)
            throw new InvalidDataException("Channel authority requires a channels map.");
        foreach (var key in channels.Select(pair => pair.Key).ToArray())
        {
            var value = channels[key];
            var legacyId = SessionCatalog.Text(value);
            if (normalize && legacyId is not null)
                channels[key] = value = new JsonObject { ["sessionId"] = legacyId };
            var colon = key.IndexOf(':');
            if (colon <= 0 || colon == key.Length - 1)
                throw new InvalidDataException("Channel authority contains an invalid binding.");
            if (value is JsonValue && legacyId is { Length: > 0 })
                continue;
            if (
                value is not JsonObject config
                || SessionCatalog.Text(config["sessionId"]) is not { Length: > 0 }
            )
                throw new InvalidDataException("Channel authority contains an invalid binding.");
            if (
                config["mode"] is not null
                && SessionCatalog.Text(config["mode"]) is not ("send-only" or "push-only")
            )
                throw new InvalidDataException("Channel authority contains an unsupported mode.");
            if (normalize && SessionCatalog.Text(config["mode"]) == "push-only")
                config["mode"] = "send-only";
            if (
                normalize
                && !config.ContainsKey("dangerouslyAllowAllUsers")
                && config.ContainsKey("dangerouslyAllowAllGroupMembers")
            )
                config["dangerouslyAllowAllUsers"] = config["dangerouslyAllowAllGroupMembers"]
                    ?.DeepClone();
            foreach (
                var flag in new[] { "dangerouslyAllowAllUsers", "dangerouslyAllowAllGroupMembers" }
            )
                if (
                    config[flag] is not null
                    && (config[flag] is not JsonValue scalar || !scalar.TryGetValue<bool>(out _))
                )
                    throw new InvalidDataException(
                        "Channel authority contains an invalid user flag."
                    );
        }
        return payload;
    }

    internal JsonArray Blockers(JsonObject payload, IEnumerable<string> ids)
    {
        var selected = ids.ToHashSet(StringComparer.Ordinal);
        var result = new JsonArray();
        foreach (var (key, value) in payload["channels"]!.AsObject())
        {
            var id = SessionCatalog.Text(value!["sessionId"])!;
            var colon = key.IndexOf(':');
            if (selected.Contains(id) && key[..colon] != "webui")
                result.Add(
                    new JsonObject
                    {
                        ["sessionId"] = id,
                        ["channelId"] = key[..colon],
                        ["conversationId"] = key[(colon + 1)..],
                    }
                );
        }
        return result;
    }

    internal void ValidateIdentityAuthority()
    {
        lock (gate)
            _ = ReadLocked("identity", normalize: false, persistMigration: false);
    }

    internal void RewriteIdentity(string from, string to)
    {
        lock (gate)
        {
            var payload = ReadLocked(from, normalize: false);
            Barrier(from, "identity-after-read");
            var changed = false;
            var channels = payload["channels"]!.AsObject();
            foreach (var (key, value) in channels.ToArray())
            {
                if (SessionCatalog.Text(value) == from)
                {
                    channels[key] = to;
                    changed = true;
                }
                else if (
                    value is JsonObject config
                    && SessionCatalog.Text(config["sessionId"]) == from
                )
                {
                    config["sessionId"] = to;
                    changed = true;
                }
            }
            if (changed)
                Write(payload);
        }
    }

    internal void Detach(string id)
    {
        lock (gate)
            DetachLocked(id);
    }

    internal void DetachForAgentCommand(string id)
    {
        lock (gate)
            DetachLocked(id, agentCommand: true);
    }

    private void DetachLocked(string id, bool agentCommand = false)
    {
        var payload = ReadLocked(id);
        Barrier(id, "after-read");
        var channels = payload["channels"]!.AsObject();
        var keys = channels
            .Where(pair => SessionCatalog.Text(pair.Value?["sessionId"]) == id)
            .Select(pair => pair.Key)
            .ToArray();
        if (!agentCommand && keys.Any(key => !key.StartsWith("webui:", StringComparison.Ordinal)))
            throw new InvalidDataException("Non-WebUI binding appeared before deletion cleanup.");
        if (keys.Length == 0)
        {
            if (ReadOptional(FilePath) is not null)
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
            return;
        }
        foreach (var key in keys)
            channels.Remove(key);
        Write(payload);
    }

    private void Barrier(string? participant, string stage)
    {
        if (participant is null)
            return;
        var hold = Path.Combine(
            root,
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment(participant) + ".channels-" + stage + "-hold"
        );
        if (!File.Exists(hold))
            return;
        File.WriteAllText(hold + ".reached", "reached");
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(hold) && DateTime.UtcNow < deadline)
            Thread.Sleep(2);
        if (File.Exists(hold))
            throw new TimeoutException("Experimental channel publication barrier expired.");
    }

    private void Write(JsonObject payload)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temp = FilePath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (
                var stream = new FileStream(
                    temp,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    4096,
                    FileOptions.WriteThrough
                )
            )
            {
                stream.Write(Encoding.UTF8.GetBytes(payload.ToJsonString()));
                stream.Flush(true);
            }
            File.Move(temp, FilePath, true);
            pendingOrdinary = null;
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(FilePath)!);
        }
        finally
        {
            File.Delete(temp);
        }
    }
}
