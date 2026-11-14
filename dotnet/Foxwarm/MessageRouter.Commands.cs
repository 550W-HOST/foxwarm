using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;

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
        return match.Success && UserCommands.IsHead(command);
    }

    internal static bool IsKnownCommand(string text, bool allowMention = false) =>
        TryReadCommand(text, out _, out _, allowMention);

    // Presentation commands (archive, parent changes) run without loading the Session.
    internal static bool IsPresentationCommand(string text) =>
        TryReadCommand(text, out var command, out var rawArgs)
        && CtlParser.ParseUser(command, rawArgs)
            is CtlUser { Command.UserHandler: "session-archive" or "session-parent" };

    // A WebUI command. Presentation, deletion and moves return their structured outcome to the
    // request; controls sent by the WebUI buttons return control feedback; every other command
    // replies in the Session like a channel command.
    private async Task<MessageRouteResult> HandleWebCommandAsync(
        ChannelContext context,
        ChannelMessage message,
        string command,
        string? rawArgs,
        SessionOwner? attachmentOwner
    )
    {
        var parsed = CtlParser.ParseUser(command, rawArgs);
        if (parsed is CtlUser { Command.UserHandler: "session-archive" or "session-parent" } presentation)
        {
            var canonical = SessionCatalog.Text(
                runtime.Catalog.Resolve(context.SessionId)["sessionId"]
            );
            if (canonical is null)
                return new(404, new JsonObject { ["error"] = "Session not found" });
            return HandlePresentationCommand(
                context with { SessionId = canonical },
                presentation.Command.Verb,
                presentation.Text("sessionId"),
                presentation.Text("parentSessionId")
            );
        }
        var owner =
            attachmentOwner
            ?? await runtime.GetOwnerAsync(context.SessionId)
            ?? throw new InvalidDataException("Session not found.");
        if (parsed is CtlUser { Command.UserHandler: "session-delete" } delete)
            return await HandleDeleteCommandAsync(context, delete.Text("sessionId")!, owner);
        if (parsed is CtlUser { Command.UserHandler: "session-move" } move)
        {
            var args = (JsonObject)move.Args.DeepClone();
            args["sessionId"] ??= context.SessionId;
            return await HandleIdentityMoveCommandAsync(context, args, owner);
        }
        if (message.ControlRequestId is { } requestId && ControlAction(command, parsed) is { } action)
            return await HandleControlAsync(owner, parsed, requestId, action);
        var source = new ExternalChannelContext(
            context.Platform,
            context.Platform,
            context.SessionId,
            null,
            null,
            text =>
            {
                runtime.ReplyToCommand(context.SessionId, text);
                return Task.CompletedTask;
            }
        );
        await HandleExternalCommandAsync(source, command, rawArgs, owner);
        return new(200, new JsonObject { ["success"] = true });
    }
}
