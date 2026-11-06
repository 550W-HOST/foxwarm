using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Display/audit evidence of where one exec ran. It never commits Session cwd or grants authority.
internal static class ExecPlacement
{
    internal const string Field = "__foxwarmExecPlacement";
    internal const string Feature = "execPlacement";
    private const int MaxPath = 4096;

    internal static JsonObject Create(
        string cwd,
        string cwdSource,
        string execId,
        string logPath,
        string? finalCwd = null
    )
    {
        var value = new JsonObject
        {
            ["cwd"] = cwd,
            ["cwdSource"] = cwdSource,
            ["execId"] = execId,
            ["logPath"] = logPath,
        };
        if (finalCwd is not null)
            value["finalCwd"] = finalCwd;
        return value;
    }

    // Accepts only the bounded peer shape; anything else is treated as absent.
    internal static JsonObject? Parse(JsonNode? raw)
    {
        if (raw is not JsonObject value)
            return null;
        string? Path(string key, bool required)
        {
            var node = value[key];
            if (node is null)
                return required ? throw new InvalidDataException() : null;
            var text =
                node is JsonValue scalar && scalar.TryGetValue<string>(out var s)
                    ? s
                    : throw new InvalidDataException();
            if (text.Length is 0 or > MaxPath || text.Contains('\0'))
                throw new InvalidDataException();
            return text;
        }
        try
        {
            var source = Path("cwdSource", true);
            if (source is not ("explicit" or "session" or "default"))
                return null;
            var execId = Path("execId", true)!;
            if (execId.Length > 128)
                return null;
            return Create(
                Path("cwd", true)!,
                source,
                execId,
                Path("logPath", true)!,
                Path("finalCwd", false)
            );
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }
}
