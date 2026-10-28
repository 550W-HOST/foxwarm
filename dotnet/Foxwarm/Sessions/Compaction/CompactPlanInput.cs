using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Plan parsing is shared by foreground submissions and the dedicated planner.
internal static class CompactPlanInput
{
    internal static string Content(JsonObject call)
    {
        if (SessionWait.Text(call["rawArgsText"]) is string raw)
            return raw;
        if (call["argsParseError"] is not null || call["args"] is not JsonObject args)
            throw new InvalidDataException("Raw compact arguments are unavailable; submit corrected direct plan fields.");
        return args.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    internal static JsonObject Arguments(JsonObject call)
    {
        if (call["argsParseError"] is not null)
            throw new CompactPlanInvalidException(SessionWait.Text(call["argsParseError"]) ?? "submit_compact_plan arguments must be valid JSON.");
        return call["args"] as JsonObject ?? throw new CompactPlanInvalidException("submit_compact_plan arguments must be an object.");
    }

    internal static string? FilePath(JsonObject args)
    {
        if (!args.ContainsKey("argsFilePath"))
            return null;
        if (args.Any(pair => pair.Key is not ("argsFilePath" or "inContext"))
            || SessionWait.Text(args["argsFilePath"]) is not { Length: > 0 } path)
            throw new CompactPlanInvalidException("Supply argsFilePath alone, or direct plan fields without argsFilePath.");
        return path;
    }

    internal static JsonObject ParseFile(string text)
    {
        JsonObject parsed;
        try
        {
            parsed = JsonNode.Parse(text) as JsonObject
                ?? throw new CompactPlanInvalidException("The plan file must contain valid JSON with a top-level object.");
        }
        catch (JsonException error)
        {
            throw new CompactPlanInvalidException("The plan file must contain valid JSON: " + error.Message);
        }
        if (parsed.ContainsKey("argsFilePath"))
            throw new CompactPlanInvalidException("The plan file must contain direct plan fields, not argsFilePath.");
        return parsed;
    }

    internal const string RepairGuidance = "Plan validation failed. The submitted plan was saved to the file below. Correct the reported error with edit or apply_patch, then resubmit using argsFilePath.";
}

// Uses ordinary file authorization and routing, including the captured selected Node/cwd.
internal sealed class CompactPlanFiles(SessionManager sessions, SessionOwner owner, string node, string? cwd, WorkspaceTools files)
{
    internal async Task<string> ReadAsync(string path, CancellationToken token)
    {
        await sessions.AuthorizeNodeFileAsync(owner, node, path, "read", files, token);
        byte[] bytes;
        if (node == "master")
            bytes = (await sessions.ReadNodeFileAsync(owner, node, path, files, token)).Bytes;
        else if (sessions.NodeProviders.IsProviderNode(node))
            bytes = await sessions.NodeProviders.ReadSourceAsync(node, path, cwd, token);
        else
            bytes = (await sessions.ReadResidentSourceAsync(owner, node, path, cwd, files, token)).Bytes;
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    internal string Node => node;
    internal string? Cwd => cwd;

    internal async Task ExecuteAsync(string name, JsonObject args, CancellationToken token)
    {
        await sessions.AuthorizeToolAsync(owner, new(name, "node", name, args, ExecutionNode: node), files, token);
        JsonObject result;
        if (node == "master")
            result = await files.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args.DeepClone() }, token);
        else
            result = (await sessions.NodeProviders.ExecuteAsync(node, name, args, owner.Id, owner.Agent, node, cwd, true, token, owner)) as JsonObject
                ?? throw new IOException("The plan file operation returned no result.");
        if (result["error"] is JsonNode error)
            throw new InvalidDataException(SessionWait.Text(error["message"]) ?? "The plan file operation failed.");
    }

    internal async Task<string> SaveAsync(string content, CancellationToken token)
    {
        var path = (node == "master" ? "$fw_tmp/" : ".temp/") + "compact-plan-" + Guid.NewGuid().ToString("N") + ".json";
        await ExecuteAsync("write", new JsonObject { ["filePath"] = path, ["content"] = content, ["createDirs"] = true }, token);
        return node == "master" ? files.Paths.FilePath(path) : path;
    }
}
