using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

// User `/` commands: the ctl registry's user ingress, parsed with the ctl grammar and run by
// the handlers below with the user's authority. Handlers call the same owner operations as the
// model's commands, without the model's tool policy, and reply with human text.
internal sealed partial class MessageRouter
{
    // One user command being run: the conversation it came from and the Session that
    // conversation is on (the WebUI Session, or the channel's attached Session).
    private sealed class UserCommand(
        SessionRuntime runtime,
        ExternalChannelContext source,
        CtlUser call,
        SessionOwner? selected
    )
    {
        private SessionOwner? current = selected;
        private bool resolved = selected is not null;

        internal ExternalChannelContext Source => source;
        internal CtlUser Call => call;
        internal string Verb => call.Command.Verb;

        internal Task Reply(string text) => source.Reply(text);

        internal string? Text(string name) => call.Text(name);

        internal bool Flag(string name) => call.Flag(name);

        internal bool Has(string name) => call.Args.ContainsKey(name);

        // The conversation's Session, or null when it has none.
        internal async Task<SessionOwner?> CurrentAsync()
        {
            if (!resolved)
            {
                resolved = true;
                var id = SessionWait.Text(
                    runtime.Manager.ChannelBinding(source.Target)?["sessionId"]
                );
                current = id is null ? null : await runtime.GetOwnerAsync(id);
            }
            return current;
        }

        internal async Task<SessionOwner> CurrentRequiredAsync() =>
            await CurrentAsync() ?? throw new UserCommandException("❌ No active session.");

        internal string? CurrentId =>
            current?.Id
            ?? SessionWait.Text(runtime.Manager.ChannelBinding(source.Target)?["sessionId"]);

        // The Session named by the option, or the conversation's Session.
        internal async Task<SessionOwner> TargetAsync(string option = "sessionId")
        {
            if (Text(option) is { } id)
                return await runtime.GetOwnerAsync(id)
                    ?? throw new UserCommandException($"❌ Session `{id}` not found.");
            return await CurrentAsync()
                ?? throw new UserCommandException("❌ No active session.");
        }

        internal string TargetId(string option = "sessionId") =>
            Text(option)
            ?? CurrentId
            ?? throw new UserCommandException("❌ No active session. Specify the Session explicitly.");

        // Attaches this conversation to a Session.
        internal void Attach(SessionOwner owner)
        {
            runtime.Manager.DetachChannel(source.Target);
            runtime.Manager.AttachChannel(source.Target, owner);
        }
    }

    // A failure whose message is the complete reply.
    private sealed class UserCommandException(string message) : Exception(message);

    // Identity discovery answers before authorization, whatever follows it. The verb is read
    // with the user lexer, so a quoted or escaped `whoami` is the same command.
    internal static bool IsWhoami(string command, string? rawArgs)
    {
        if (command == "/whoami")
            return true;
        if (command != "/channel")
            return false;
        try
        {
            return new CtlLexer(rawArgs ?? "", shell: false).Next() is { Text: "whoami" };
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static async Task WhoamiAsync(ExternalChannelContext source)
    {
        try
        {
            await source.Reply(
                "User ID: "
                    + (source.Sender ?? "(unavailable)")
                    + "\nChannel Target ID: "
                    + source.Target
            );
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel identity reply failed: " + error.Message);
        }
    }

    internal async Task<bool> HandleExternalCommandAsync(
        ExternalChannelContext source,
        string command,
        string? rawArgs,
        SessionOwner? selectedOwner = null
    )
    {
        if (!runtime.Manager.Accepting)
            return true;
        // Unknown slash text is ordinary input, including at Telegram's pre-Router hook.
        // Catalog classification must precede command authorization; ordinary admission
        // still checks authorization and guest provisioning in HandleExternalMessageAsync.
        if (!UserCommands.IsHead(command))
            return false;
        if (IsWhoami(command, rawArgs))
        {
            await WhoamiAsync(source);
            return true;
        }
        var auth = runtime.Manager.ChannelAuthorization?.Inspect(source);
        if (selectedOwner is null && auth is null)
            throw new InvalidOperationException("External channel ingress is not initialized.");
        if (auth is { Authorized: false })
        {
            await source.Reply(auth.Describe(source, unauthorized: true));
            return true;
        }
        try
        {
            switch (CtlParser.ParseUser(command, rawArgs))
            {
                case CtlHelpRequest help:
                    await source.Reply(
                        CtlHelp.Render(help, _ => true, UserCommands.Ingress)
                            ?? CtlHelp.Error(CtlHelp.Unknown(help), _ => true, UserCommands.Ingress)
                    );
                    break;
                case CtlError error:
                    await source.Reply("❌ " + CtlHelp.Error(error, _ => true, UserCommands.Ingress));
                    break;
                case CtlUser call:
                    await RunUserCommandAsync(new UserCommand(runtime, source, call, selectedOwner));
                    break;
            }
        }
        catch (UserCommandException error)
        {
            await source.Reply(error.Message);
        }
        catch (Exception error)
        {
            await source.Reply(
                error.Message.StartsWith("❌", StringComparison.Ordinal)
                    ? error.Message
                    : "❌ " + error.Message
            );
        }
        return true;
    }

    private Task RunUserCommandAsync(UserCommand command) =>
        command.Call.Command.UserHandler switch
        {
            "session-status" => SessionStatusAsync(command),
            "session-list" => SessionListAsync(command),
            "session-rename" => SessionRenameAsync(command),
            "session-parent" or "session-archive" => SessionPresentationAsync(command),
            "session-create" => SessionCreateAsync(command),
            "session-new" => SessionNewAsync(command),
            "session-move" => SessionMoveAsync(command),
            "session-delete" => SessionDeleteAsync(command),
            "session-clear" => SessionClearAsync(command),
            "session-stop" => SessionStopAsync(command),
            "session-continue" => SessionContinueAsync(command),
            "session-dequeue" => SessionDequeueAsync(command),
            "session-btw" => SessionBtwAsync(command),
            "session-model" => SessionModelAsync(command, child: false),
            "session-child-model" => SessionModelAsync(command, child: true),
            "session-fork" => SessionForkAsync(command),
            "session-messages" => SessionMessagesAsync(command),
            "session-delete-messages" => SessionDeleteMessagesAsync(command),
            "session-verbose" => SessionVerboseAsync(command),
            "session-index" => SessionIndexAsync(command),
            "session-refresh" => SessionRefreshAsync(command),
            "session-compact-threshold" => SessionCompactThresholdAsync(command),
            "session-compact" => SessionCompactAsync(command),
            "history-search" => HistorySearchAsync(command),
            "agent-list" => AgentListAsync(command),
            "agent-create" => AgentCreateAsync(command),
            "agent-inherit" => AgentInheritAsync(command),
            "agent-delete" => AgentDeleteAsync(command),
            "skill-list" => SkillListAsync(command),
            "skill-load" => SkillLoadAsync(command),
            "timer-create" => TimerCreateAsync(command),
            "timer-list" => TimerListAsync(command),
            "timer-delete" => TimerDeleteAsync(command),
            "timer-pause" or "timer-resume" => TimerPauseAsync(command),
            "node-list" => NodeListAsync(command),
            "node-select" => NodeSelectAsync(command),
            "node-inspect" => NodeInspectAsync(command),
            "node-remove" => NodeRemoveAsync(command),
            "node-pair-list" => command.Reply(NodePairList()),
            "node-approve" => NodeApproveAsync(command),
            "node-reject" => NodeRejectAsync(command),
            "node-token" => NodeTokenAsync(command),
            "node-bootstrap-info" => command.Reply(NodeBootstrapInfo()),
            "node-rename" => NodeRenameAsync(command),
            "channel-whoami" => WhoamiAsync(command.Source),
            "channel-attach" => ChannelAttachAsync(command),
            "channel-info" => ChannelInfoAsync(command),
            "channel-auth" => command.Reply(Authorization(command.Source).Describe(command.Source)),
            "channel-status" => command.Reply(FormatChannelStatus(command.Text("channel"))),
            "channel-runtime" => ChannelRuntimeAsync(command),
            "channel-mode" => ChannelModeAsync(command),
            "channel-allow-all" => ChannelAllowAllAsync(command),
            "channel-weixin" => HandleWeixinCommandAsync(command),
            var handler => throw new InvalidOperationException("Unknown user command handler: " + handler),
        };

    private static string? EffortValue(string? raw)
    {
        if (raw is null)
            return null;
        raw = raw.Trim().ToLowerInvariant();
        return raw is "default" or "unset" ? null
            : Foxwarm.Models.HostModels.Efforts.Contains(raw) ? raw
            : throw new InvalidDataException(
                "Effort must be one of: "
                    + string.Join(", ", Foxwarm.Models.HostModels.Efforts)
                    + ", default, or unset."
            );
    }

    private static double? KeepPercent(UserCommand command) =>
        command.Call.Number("keepPercent") is > 0 and <= 100 and var value ? value / 100 : null;
}
