using System.Security.Cryptography;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Models;

namespace Foxwarm.Images;

internal static class ProviderImageDedup
{
    private sealed class Marker { }
    private static readonly ConditionalWeakTable<JsonObject, Marker> Duplicates = new();
    internal static bool IsDeduplicated(JsonObject part) => Duplicates.TryGetValue(part, out _);
    internal static void Apply(IReadOnlyList<JsonObject> history, string protocol)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var message in history)
        {
            var parts = (message["parts"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
            if (!CompactCandidateBuilder.Visible(message)) continue;
            IEnumerable<int> order;
            var role = SessionWait.Text(message["role"]);
            if (role == "tool" && protocol == "anthropic")
            {
                var emitted = new HashSet<string>(StringComparer.Ordinal); var indexes = new List<int>();
                for (var i = 0; i < parts.Length; i++)
                    if (parts[i]["functionResponse"] is JsonObject response)
                    {
                        var id = SessionWait.Text(response["tool_use_id"]) ?? SessionWait.Text(parts[i]["toolUseId"]) ?? "unknown";
                        if (emitted.Add(id)) indexes.AddRange(Enumerable.Range(0, parts.Length).Where(j => parts[j]["inlineData"] is not null && SessionWait.Text(parts[j]["toolUseId"]) == id));
                    }
                    else if (parts[i]["inlineData"] is not null && string.IsNullOrEmpty(SessionWait.Text(parts[i]["toolUseId"]))) indexes.Add(i);
                order = indexes;
            }
            else if (role == "tool")
            {
                var groups = ProviderImageParts.ToolGroups(parts);
                order = groups.SelectMany(group => group.Parts).Where(part => part["inlineData"] is not null).Select(part => Array.IndexOf(parts, part));
            }
            else order = Enumerable.Range(0, parts.Length).Where(index => parts[index]["inlineData"] is not null
                && !(role == "model" && (protocol == "responses" || SessionWait.Text(parts[index]["imageMeta"]?["origin"]) == "generated")));
            foreach (var index in order)
            {
                var part = parts[index]; var inline = part["inlineData"]!.AsObject(); var bytes = ImageBlobStore.InlineBytes(inline);
                if (bytes.Length > 32 * 1024 * 1024) continue;
                var identity = ImageBlobStore.Mime(inline) + "\0" + Convert.ToHexStringLower(SHA256.HashData(bytes));
                if (seen.Add(identity)) continue;
                part.Remove("inlineData"); Duplicates.GetValue(part, _ => new Marker());
                _ = MarkDescriptor(parts, index);
            }
        }
    }
    private static bool MarkDescriptor(JsonObject[] parts, int index)
    {
        foreach (var candidate in new[] { index, index - 1, index + 1 })
        {
            if (candidate < 0 || candidate >= parts.Length || candidate != index && (parts[candidate]["inlineData"] is not null || parts[candidate]["inlineDataRef"] is not null)
                || SessionWait.Text(parts[candidate]["text"]) is not { } text) continue;
            var lines = text.Split('\n');
            for (var i = lines.Length - 1; i >= 0; i--)
            {
                var line = lines[i].Trim();
                if (!Regex.IsMatch(line, "^<foxwarm-image(?:\\s+[^<>]*)?\\s*/>$", RegexOptions.CultureInvariant)) continue;
                line = Regex.Replace(line, "\\s+deduplicated=(?:\"[^\"]*\"|'[^']*')", "", RegexOptions.CultureInvariant);
                lines[i] = line[..^2].TrimEnd() + " deduplicated=\"true\" />"; parts[candidate]["text"] = string.Join('\n', lines); return true;
            }
        }
        return false;
    }
}
