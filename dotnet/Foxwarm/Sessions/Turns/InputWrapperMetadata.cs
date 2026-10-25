using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal static class InputWrapperMetadata
{
    internal static void StampSequence(JsonObject message)
    {
        if (
            SessionWait.Text(message["role"]) != "user"
            || !CompactCandidateBuilder.Visible(message)
            || CompactCandidateBuilder.Number(message["__meta"]?["seq"]) is not long seq
            || seq <= 0
            || message["parts"] is not JsonArray parts
        )
            return;
        SetAttribute(parts, "seq", seq.ToString(CultureInfo.InvariantCulture));
    }

    // Only inspect successive opening metadata parts and the existing outer source wrapper.
    // Never look for a wrapper inside a body, attachment, or historical request projection.
    internal static void SetAttribute(JsonArray parts, string name, string value)
    {
        foreach (var part in parts.OfType<JsonObject>())
        {
            if (SessionWait.Text(part["system"]) is not { } system)
                return;
            var opening = Regex.Match(
                system,
                @"^(\s*)<foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)>",
                RegexOptions.IgnoreCase
            );
            if (!opening.Success)
                return;
            var tag = opening.Groups[2].Value.ToLowerInvariant();
            var attributes = opening.Groups[3].Value;
            var kind = Regex
                .Matches(attributes, "([a-zA-Z_:][a-zA-Z0-9_.:-]*)\\s*=\\s*\"([^\"]*)\"")
                .LastOrDefault(match => match.Groups[1].Value == "kind")
                ?.Groups[2]
                .Value;
            if (tag == "system" && kind is "session" or "channel-mode" or "time")
            {
                if (
                    !Regex.IsMatch(system, @"/\s*>\s*$")
                    || system[opening.Length..].Trim().Length != 0
                )
                    return;
                continue;
            }
            if (tag is not ("message" or "system"))
                return;
            var head = Regex.Replace(
                opening.Value,
                "\\s+" + Regex.Escape(name) + "\\s*=\\s*\"[^\"]*\"",
                ""
            );
            var end = Regex.Match(head, @"\s*/?\s*>$");
            var selfClosing = Regex.IsMatch(end.Value, @"/\s*>$");
            part["system"] =
                head[..end.Index]
                + " "
                + name
                + "=\""
                + LocalSessionTurnHost.EscapeFoxwarmAttribute(value)
                + "\""
                + (selfClosing ? " />" : ">")
                + system[opening.Length..];
            return;
        }
    }
}
