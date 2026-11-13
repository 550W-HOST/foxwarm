using System.Text.RegularExpressions;
using Foxwarm.Channels;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    // Match a complete catalog command head, not a slash prefix (which may be a file path).
    // Keep the Source whitespace grammar shared with presentation commands and scoped ingress.
    internal static bool TryReadCommand(
        string text,
        out string command,
        out string? rawArgs,
        bool allowMention = false
    )
    {
        var match = Regex.Match(
            text,
            "^"
                + CommandSpace
                + "*"
                + (allowMention ? "(?:@[a-zA-Z_\\-.]+" + CommandSpace + "+)?" : "")
                + "(/[a-zA-Z_\\-.]+)(?:"
                + CommandSpace
                + "+([\\s\\S]*))?$"
        );
        command = match.Groups[1].Value;
        rawArgs = match.Groups[2].Success ? match.Groups[2].Value : null;
        return match.Success && ExternalCommands.Find(command) is not null;
    }

    internal static bool IsKnownCommand(string text, bool allowMention = false) =>
        TryReadCommand(text, out _, out _, allowMention);
}
