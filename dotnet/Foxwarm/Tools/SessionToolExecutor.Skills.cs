using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    // `skill`: a load with a path reads one resource here, where a script's data budget and
    // structured read results are available; every other form is the Session manager's.
    private async Task<JsonObject> ExecuteSkillAsync(JsonObject args, CancellationToken token)
    {
        var action = SessionWait.Text(args["action"])?.Trim().ToLowerInvariant();
        if (action == "load" && args.ContainsKey("path"))
            return await ReadSkillResourceAsync(args, token);
        if (action == "copy")
            return await CopySkillAsync(args, token);
        return await ExecuteAgentAsync("skill", args, token);
    }

    // `skill copy`: files read through the skill subsystem on the Main server, written to a
    // Node through the target leg of copy_between_nodes. The `skill` rule covers the source;
    // each destination file is checked as a write on that Node before anything is written.
    private async Task<JsonObject> CopySkillAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(
            args,
            ["action", "skillName", "targetPath", "path", "node", "overwrite", "agentName"]
        );
        var name =
            SessionWait.Text(args["skillName"])?.Trim() is { Length: > 0 } skillName
                ? skillName
                : throw new InvalidDataException("skillName is required.");
        var targetPath =
            ToolRegistry.Text(args, "targetPath") is { } target && target.Trim().Length > 0
                ? target
                : throw new InvalidDataException("targetPath is required.");
        var path = args.ContainsKey("path")
            ? ToolRegistry.Text(args, "path") ?? throw new InvalidDataException("path must be a string.")
            : null;
        var node = ToolRegistry.Text(args, "node")?.Trim() is { Length: > 0 } named ? named : ExecutionNode;
        var overwrite = args["overwrite"] switch
        {
            null => false,
            JsonValue flag when flag.TryGetValue<bool>(out var value) => value,
            _ => throw new InvalidDataException("overwrite must be boolean."),
        };
        var agent = Skills.RequestedAgent(SessionWait.Text(args["agentName"]), hosted.Agent);
        var info = await sessions.SkillCatalog.ResolveAsync(name, agent);
        var plan = Skills.CopyPlan(info, path, targetPath);
        var files = Files ?? sessions.IdentityWorkspace(hosted);
        foreach (var file in plan)
            await sessions.AuthorizeNodeFileAsync(hosted, node, file.Target, "write", files, token);
        var cwd = node == ExecutionNode ? ExecutionCwd : null;
        var copied = new JsonArray();
        long total = 0;
        foreach (var file in plan)
        {
            var bytes = await File.ReadAllBytesAsync(file.FullPath, token);
            var entry = new JsonObject
            {
                ["path"] = file.Path,
                ["bytes"] = (long)bytes.Length,
                ["sha256"] = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
            };
            try
            {
                using var input = new MemoryStream(bytes, writable: false);
                await sessions.WriteNodeStreamAsync(
                    hosted,
                    node,
                    file.Target,
                    input,
                    bytes.Length,
                    overwrite,
                    files,
                    token,
                    sessionCwd: cwd
                );
                total += bytes.Length;
            }
            catch (Exception error)
                when (error is IOException or Foxwarm.Nodes.NodeProviderException or InvalidDataException)
            {
                // An existing file without overwrite, or another write failure, fails that file.
                entry.Remove("sha256");
                entry["error"] = error.Message;
            }
            copied.Add(entry);
        }
        var result = new JsonObject
        {
            ["skill"] = info.Name,
            ["sourceType"] = info.SourceType,
            ["agent"] = info.SourceAgent,
            ["node"] = node,
            ["targetPath"] = targetPath,
            ["files"] = copied,
            ["totalBytes"] = total,
        };
        // A model sees the first 50 files; a script gets all of them.
        if (!Programmatic && copied.Count > 50)
        {
            result["files"] = new JsonArray(copied.Take(50).Select(item => item?.DeepClone()).ToArray());
            result["moreFiles"] = copied.Count - 50;
        }
        return result;
    }

    // `skill load <name> <path>`: read through the skill subsystem on the Main server, under the
    // `skill` rule alone (no Node read is authorized), formatted as `read` formats a file.
    private async Task<JsonObject> ReadSkillResourceAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["action", "skillName", "agentName", "path", "startLine", "endLine"]);
        var name =
            SessionWait.Text(args["skillName"])?.Trim() is { Length: > 0 } skillName
                ? skillName
                : throw new InvalidDataException("skillName is required.");
        var path =
            SessionWait.Text(args["path"])
            ?? throw new InvalidDataException("path must be a string.");
        double? Bound(string key) =>
            args[key] is null
                ? null
                : SessionWait.Number(args[key])
                    ?? throw new InvalidDataException(key + " must be a number.");
        var first = Bound("startLine");
        var last = Bound("endLine");
        var agent = Skills.RequestedAgent(SessionWait.Text(args["agentName"]), hosted.Agent);
        var info = await sessions.SkillCatalog.ResolveAsync(name, agent);
        var resource = Skills.ResourcePath(info, path);
        if (resource.IsDirectory)
            return new JsonObject
            {
                ["output"] = SkillResourceListing(resource),
            };
        byte[] header;
        long size;
        await using (
            var stream = new FileStream(
                resource.FullPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            )
        )
        {
            size = stream.Length;
            header = new byte[(int)Math.Min(Foxwarm.Images.RasterImageMime.HeaderBytes, size)];
            await stream.ReadExactlyAsync(header, token);
        }
        var mime = Foxwarm.Images.RasterImageMime.Detect(header);
        // Charged as a Main `read` of the same file.
        ScriptBudget?.Charge(mime is not null ? checked(12L * size) : 32L * 1024 * 1024);
        if (mime is not null)
            return new JsonObject
            {
                ["output"] = "[Image loaded: " + resource.Display + "]",
                ["mimeType"] = mime,
                ["inlineData"] = new JsonObject
                {
                    ["mimeType"] = mime,
                    ["data"] = Convert.ToBase64String(
                        await File.ReadAllBytesAsync(resource.FullPath, token)
                    ),
                },
            };
        JsonObject? data = null;
        var text = await FileToolCore.Read(
            resource.FullPath,
            resource.Display,
            first,
            last,
            token,
            Programmatic ? value => data = value : null
        );
        var result = new JsonObject { ["output"] = $"FILE: {resource.Display}\n{text}" };
        if (data is not null)
        {
            // Structured fields as a programmatic `read` returns them, naming the resource
            // instead of its Main server path.
            data.Remove("filePath");
            foreach (var (key, value) in data)
                result[key] = value?.DeepClone();
            result["path"] = resource.Path;
        }
        return result;
    }

    // The resources under one directory of a skill, listed as `skill load` lists them.
    internal static string SkillResourceListing(SkillResource resource) =>
        $"DIRECTORY: {resource.Display}\n"
        + string.Join('\n', resource.Files.Select(file => "- " + file))
        + (resource.Truncated ? "\n- ... (resource listing truncated)" : "")
        + "\n";

    // `ctl skill run`: the entry (or with `script`, another ToolScript file of the skill) is read
    // through the skill subsystem on the Main server (never a Node read), an entry's args are
    // checked against the skill's schema, and it then runs exactly as an inline run_script with
    // the caller's authority. Every nested call keeps its own gate.
    private async Task<JsonObject> ExecuteRunSkillAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["skillName", "args", "mode", "timeoutSecs", "agentName", "script"]);
        var name =
            SessionWait.Text(args["skillName"])?.Trim() is { Length: > 0 } skillName
                ? skillName
                : throw new InvalidDataException("skillName is required.");
        var agent = Skills.RequestedAgent(SessionWait.Text(args["agentName"]), hosted.Agent);
        var input = args["args"] ?? new JsonObject();
        SkillEntry entry;
        if (args.ContainsKey("script"))
        {
            // A resource declares no schema, so its args pass unchecked, and the entry's
            // mode and budget do not apply to it.
            entry = await sessions.SkillCatalog.ReadScriptAsync(
                name,
                agent,
                ToolRegistry.Text(args, "script") ?? throw new InvalidDataException("script must be a string."),
                token
            );
        }
        else
        {
            entry = await sessions.SkillCatalog.ReadEntryAsync(name, agent, token);
            try
            {
                Skills.ValidateArgs(entry.Run!.Args, input);
            }
            catch (InvalidDataException error)
            {
                throw new InvalidDataException(
                    $"Invalid arguments for skill `{entry.Info.Name}`: {error.Message} `ctl skill run {entry.Info.Name} --help` lists them."
                );
            }
        }
        var start = new JsonObject
        {
            ["code"] = entry.Code,
            ["args"] = input.DeepClone(),
            ["mode"] = SessionWait.Text(args["mode"]) ?? entry.Run?.Mode ?? "foreground",
        };
        if (args["timeoutSecs"] is { } timeout)
            start["timeoutSecs"] = timeout.DeepClone();
        else if (entry.Run?.TimeoutSecs is { } seconds)
            start["timeoutSecs"] = seconds;
        return await ExecuteToolScriptAsync("run_skill", start, token, entry);
    }
}
