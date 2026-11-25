using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    // `skill`: a load with a path reads one resource here, where a script's data budget and
    // structured read results are available; every other form is the Session manager's.
    private async Task<JsonObject> ExecuteSkillAsync(JsonObject args, CancellationToken token)
    {
        if (
            args.ContainsKey("path")
            && SessionWait.Text(args["action"])?.Trim().ToLowerInvariant() == "load"
        )
            return await ReadSkillResourceAsync(args, token);
        return await ExecuteAgentAsync("skill", args, token);
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

    // `ctl skill run`: the entry is read through the skill subsystem on the Main server (never a
    // Node read), its args are checked against the skill's schema, and it then runs exactly as
    // an inline run_script with the caller's authority. Every nested call keeps its own gate.
    private async Task<JsonObject> ExecuteRunSkillAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["skillName", "args", "mode", "timeoutSecs", "agentName"]);
        var name =
            SessionWait.Text(args["skillName"])?.Trim() is { Length: > 0 } skillName
                ? skillName
                : throw new InvalidDataException("skillName is required.");
        var agent = Skills.RequestedAgent(SessionWait.Text(args["agentName"]), hosted.Agent);
        var entry = await sessions.SkillCatalog.ReadEntryAsync(name, agent, token);
        var input = args["args"] ?? new JsonObject();
        try
        {
            Skills.ValidateArgs(entry.Run.Args, input);
        }
        catch (InvalidDataException error)
        {
            throw new InvalidDataException(
                $"Invalid arguments for skill `{entry.Info.Name}`: {error.Message} `ctl skill run {entry.Info.Name} --help` lists them."
            );
        }
        var start = new JsonObject
        {
            ["code"] = entry.Code,
            ["args"] = input.DeepClone(),
            ["mode"] = SessionWait.Text(args["mode"]) ?? entry.Run.Mode,
        };
        if (args["timeoutSecs"] is { } timeout)
            start["timeoutSecs"] = timeout.DeepClone();
        else if (entry.Run.TimeoutSecs is { } seconds)
            start["timeoutSecs"] = seconds;
        return await ExecuteToolScriptAsync("run_skill", start, token, entry);
    }
}
