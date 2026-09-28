using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.SessionPersistence;
using Foxwarm.SessionTurns;

namespace Foxwarm.ExperimentHost;

internal static class ArchiveRecallTool
{
    private const long MaxSafeInteger = 9007199254740991;
    private const int PageSize = 12000;
    private static readonly Regex ExactTarget = new("^msg#([1-9][0-9]*)$", RegexOptions.CultureInvariant);

    public static JsonObject Definition() => JsonNode.Parse("""
        {"type":"function","name":"recall","description":"Read the original archived message at an exact message sequence number in the current session. Returns up to 12,000 Unicode characters of the stored message JSON per call. Use nextOffset from the result to read the next portion. This tool does not search or read other sessions.","parameters":{"type":"object","properties":{"target":{"type":"string","description":"Exact message reference in the form msg#123.","pattern":"^msg#[1-9][0-9]*$"},"offset":{"type":"integer","minimum":0,"description":"Number of Unicode characters to skip in the stored message JSON. Defaults to 0."}},"required":["target"],"additionalProperties":false},"strict":false}
        """)!.AsObject();

    public static JsonObject Execute(SqliteArchiveMessageStore archive, JsonObject? args)
    {
        if (args is null || args.Count is < 1 or > 2 || args.Any(item => item.Key is not ("target" or "offset"))
            || args["target"] is not JsonValue targetValue || !targetValue.TryGetValue<string>(out var target))
            return Error("invalid_tool_arguments", "recall expects target msg#<positive seq> and optional nonnegative offset.");
        var match = ExactTarget.Match(target);
        if (!match.Success || match.Length != target.Length
            || !long.TryParse(match.Groups[1].Value, out var seq) || seq > MaxSafeInteger)
            return Error("invalid_tool_arguments", "Only exact current-Session target msg#<positive seq> is supported.");
        long offset = 0;
        if (args.ContainsKey("offset") && (args["offset"] is not JsonValue raw
            || !raw.TryGetValue<long>(out offset) || offset is < 0 or > MaxSafeInteger))
            return Error("invalid_tool_arguments", "offset must be a nonnegative safe integer.");
        var record = archive.ReadMessageBySeq(seq);
        if (record is null) return Error("not_found", $"Original archived message {target} was not found.");
        var runes = record.MessageJson.EnumerateRunes().ToArray();
        var start = (int)Math.Min(offset, runes.Length);
        var length = Math.Min(PageSize, runes.Length - start);
        var text = string.Concat(runes.Skip(start).Take(length).Select(rune => rune.ToString()));
        var result = new JsonObject { ["target"] = target, ["offset"] = offset,
            ["text"] = text, ["totalCharacters"] = runes.Length };
        if (start + length < runes.Length) result["nextOffset"] = start + length;
        return result;
    }
    private static JsonObject Error(string code, string message) => UnsupportedTurnToolExecutor.ToolError(code, message);
}
