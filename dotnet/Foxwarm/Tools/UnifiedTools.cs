using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record SearchTool(string Source, string Name, string Description, JsonNode? Schema, string? Scope, bool Hidden, int Score);
internal static partial class UnifiedTools
{
    internal static async Task<JsonObject> SearchAsync(ToolRegistry registry, JsonObject args, CancellationToken token, Func<string, string, string?, bool>? visible = null)
    {
        ToolRegistry.Keys(args, ["query", "sources", "server", "nodeId", "limit", "includeSchema"]);
        var query = ToolRegistry.Text(args, "query") ?? "";
        var sources = args["sources"] switch
        {
            null => new[] { "builtin", "mcp", "node" },
            JsonArray array => array.Select(value => SessionWait.Text(value)?.Trim() ?? "").Where(value => value.Length > 0).Distinct(StringComparer.Ordinal).ToArray(),
            _ => new[] { ToolRegistry.Text(args, "sources")!.Trim() }
        };
        if (sources.Length == 0) sources = ["builtin", "mcp", "node"];
        if (sources.Any(source => source is not ("builtin" or "mcp" or "node"))) throw new InvalidDataException("Invalid sources. Supported sources: builtin, mcp, node.");
        var schema = args["includeSchema"] is null || args["includeSchema"]!.GetValue<bool>();
        var numeric = SessionWait.Number(args["limit"]);
        if (numeric is null && SessionWait.Text(args["limit"]) is string text && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) numeric = parsed;
        var limit = numeric is double number && double.IsFinite(number) ? (int)Math.Clamp(Math.Truncate(number), 1, 200) : 5;
        var collected = new List<SearchTool>(); var warnings = new List<string>();
        foreach (var entry in registry.Entries.Where(entry => entry.Definition["name"]!.GetValue<string>() != "call_tool" && sources.Contains(entry.Source)))
        {
            if (entry.Source == "node") continue;
            var name = SessionWait.Text(entry.Definition["name"])!; var description = SessionWait.Text(entry.Definition["description"]) ?? "";
            if (visible is not null && !visible(entry.Source, name, null)) continue;
            var score = Score(query, name, description);
            if (score >= 0) collected.Add(new(entry.Source, name, description, entry.Definition["parameters"], null, !entry.DefaultInject, score));
        }
        if (sources.Contains("node"))
        {
            try
            {
                ToolRegistry.LocalNode(ToolRegistry.Text(args, "nodeId"));
                foreach (var entry in registry.Entries.Where(entry => entry.Source == "node"))
                {
                    var name = SessionWait.Text(entry.Definition["name"])!; var description = SessionWait.Text(entry.Definition["description"]) ?? "";
                    if (visible is not null && !visible("node", name, null)) continue;
                    var score = Score(query, name, description, "master");
                    if (score >= 0) collected.Add(new("node", name, description, entry.Definition["parameters"], "master", !entry.DefaultInject, score));
                }
            }
            catch (InvalidDataException error) { warnings.Add(error.Message); }
        }
        if (sources.Contains("mcp"))
        {
            var filter = ToolRegistry.Text(args, "server")?.Trim();
            string[] servers;
            try { servers = !string.IsNullOrEmpty(filter) ? new[] { filter } : registry.Mcp.Summaries().OfType<JsonObject>().Where(row => row["enabled"]!.GetValue<bool>()).Select(row => SessionWait.Text(row["name"])!).ToArray(); }
            catch (Exception) { warnings.Add("MCP server discovery failed; configuration is unavailable."); servers = []; }
            foreach (var server in servers)
            {
                token.ThrowIfCancellationRequested();
                try
                {
                    foreach (var tool in await registry.Mcp.ListToolsAsync(server, token))
                    {
                        var name = SessionWait.Text(tool["name"]) ?? "unknown"; var description = SessionWait.Text(tool["description"]) ?? "";
                        if (visible is not null && !visible("mcp", name, server)) continue;
                        var score = Score(query, name, description, server);
                        if (score >= 0) collected.Add(new("mcp", name, description, tool["inputSchema"], server, true, score));
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (ToolAuthorizationUnavailableException) { throw; }
                catch (Exception error) { warnings.Add("MCP server " + server + ": " + error.Message); }
            }
        }
        var comparer = StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false);
        var sorted = collected.OrderByDescending(tool => tool.Score).ThenBy(tool => tool.Source, comparer).ThenBy(tool => tool.Scope ?? "", comparer).ThenBy(tool => tool.Name, comparer).Take(limit).ToArray();
        return new JsonObject { ["output"] = Render(sorted, collected.Count, warnings, schema) };
    }
    private static int Score(string query, params string[] fields)
    {
        query = query.Trim().ToLowerInvariant(); if (query.Length == 0) return 0;
        var terms = Regex.Split(query, "\\s+").Distinct(StringComparer.Ordinal).ToArray(); var normalized = fields.Select(field => field.ToLowerInvariant()).ToArray();
        var primary = normalized[0]; var score = primary == query ? 400 : primary.StartsWith(query, StringComparison.Ordinal) ? 260 : primary.Contains(query, StringComparison.Ordinal) ? 180 : normalized.Any(field => field.Contains(query, StringComparison.Ordinal)) ? 120 : 0;
        var matches = 0;
        foreach (var term in terms)
            for (var index = 0; index < normalized.Length; index++) if (normalized[index].Contains(term, StringComparison.Ordinal))
            { matches++; score += index == 0 ? 40 : 24; if (normalized[index].StartsWith(term, StringComparison.Ordinal)) score += index == 0 ? 16 : 8; break; }
        return matches == 0 ? -1 : score + matches * 12 + (matches == terms.Length && terms.Length > 1 ? 90 : 0);
    }
    private static string Render(SearchTool[] tools, int total, IReadOnlyList<string> warnings, bool schema)
    {
        var lines = new List<string>(); var omitted = 0;
        for (var index = 0; index < tools.Length; index++)
        {
            var tool = tools[index]; var type = schema && index < 10 ? SchemaType(tool.Schema, 0) : "unknown /* schema omitted */";
            var safe = SafeIdentity(tool.Name) && (tool.Scope is null || SafeIdentity(tool.Scope));
            var identity = tool.Source == "builtin" ? "builtin:" + tool.Name : tool.Source + ":" + tool.Scope + "/" + tool.Name;
            var descriptor = safe ? "toolId: " + Quote(identity) : "source: " + Quote(tool.Source) + ", name: " + Quote(tool.Name) + (tool.Scope is null ? "" : ", " + (tool.Source == "mcp" ? "server" : "nodeId") + ": " + Quote(tool.Scope));
            var line = "call_tool({ " + descriptor + ", args: " + type + " }); /* " + Comment(tool.Description, 240) + (tool.Hidden ? " [hidden]" : "") + " */";
            if (line.Length > 3000 || lines.Sum(item => item.Length + 1) + line.Length > 27_800) { omitted++; continue; }
            lines.Add(line);
        }
        var header = $"Found {lines.Count} tool(s); {total} total match(es).";
        if (omitted > 0) lines.Add($"{omitted} selected tool(s) omitted by declaration/output limits.");
        var builder = new StringBuilder(header + "\n\n" + string.Join('\n', lines));
        foreach (var warning in warnings)
        { var line = "\nWarning: " + Comment(warning, 500); if (builder.Length + line.Length > 31_800) break; builder.Append(line); }
        if (total > tools.Length) builder.Append("\nIncrease limit or narrow query/source to inspect more matches.");
        return builder.ToString();
    }
    private static bool SafeIdentity(string value) => value.Length > 0 && Regex.IsMatch(value, "^[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant);
    private static string Escape(string text)
    {
        var builder = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            var code = rune.Value;
            if (code <= 0x1f || code is >= 0x7f and <= 0x9f || code is 0x061c or 0x200e or 0x200f or 0x2028 or 0x2029 || code is >= 0x202a and <= 0x202e || code is >= 0x2066 and <= 0x2069) builder.Append("\\u" + code.ToString("x4", CultureInfo.InvariantCulture));
            else builder.Append(rune.ToString());
        }
        return builder.ToString();
    }
    private static string Quote(string text)
    {
        var builder = new StringBuilder("\"");
        foreach (var rune in text.EnumerateRunes())
        {
            var piece = rune.ToString(); var escaped = Escape(piece);
            builder.Append(escaped != piece ? escaped : piece == "\\" ? "\\\\" : piece == "\"" ? "\\\"" : piece);
        }
        return builder.Append('"').ToString();
    }
    private static string Comment(string text, int max)
    {
        text = Regex.Replace(Escape(text), "\\s+", " ").Trim().Replace("*/", "*\\/", StringComparison.Ordinal);
        var runes = text.EnumerateRunes().ToArray(); return runes.Length <= max ? text : string.Concat(runes.Take(max - 1).Select(rune => rune.ToString())) + "…";
    }
}
