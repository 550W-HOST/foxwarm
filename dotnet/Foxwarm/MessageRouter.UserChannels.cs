using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

// `/channel` commands.
internal sealed partial class MessageRouter
{
    private async Task ChannelAttachAsync(UserCommand command)
    {
        var id = command.Text("sessionId")!;
        var target =
            await runtime.GetOwnerAsync(id)
            ?? throw new UserCommandException("❌ Session `" + id + "` not found.");
        command.Attach(target);
        await command.Reply(
            "✅ Attached to session `"
                + target.Id
                + "`"
                + (target.Metadata().DisplayName is { } display ? " (" + display + ")" : "")
        );
    }

    private async Task ChannelInfoAsync(UserCommand command)
    {
        var source = command.Source;
        var binding = runtime.Manager.ChannelBinding(source.Target);
        await command.Reply(
            $"*Channel info*\n- channelId: `{source.Instance}`\n- channelType: `{source.Type}`\n- conversationId: `{source.Conversation}`\n- channelTargetId: `{source.Target}`\n- senderId: `{source.Sender ?? "(none)"}`"
                + (source.Username is null ? "" : $"\n- username: `{source.Username}`")
                + $"\n- attachedSession: `{SessionWait.Text(binding?["sessionId"]) ?? "(none)"}`"
                + $"\n- mode: `{SessionWait.Text(binding?["mode"]) ?? "normal"}`"
                + $"\n- dangerouslyAllowAllUsers: `{(SessionCatalog.Flag(binding?["dangerouslyAllowAllUsers"]) ? "yes" : "no")}`"
        );
    }

    private async Task ChannelRuntimeAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var channel = command.Text("channel")!;
        var verb = command.Verb;
        var wasRunning = manager
            .ManagedChannels!.Statuses()
            .OfType<JsonObject>()
            .Any(row =>
                SessionWait.Text(row["channelId"]) == channel && SessionCatalog.Flag(row["running"])
            );
        await manager.ManagedChannels.ChangeAsync(verb, channel);
        var outcome =
            verb == "restart" ? "restarted"
            : verb == "start"
                ? wasRunning ? "was already running"
                    : "started"
            : wasRunning ? "stopped"
            : "was already stopped";
        await command.Reply($"✅ Channel `{channel}` {outcome}.\n" + FormatChannelStatus(channel));
    }

    private async Task ChannelModeAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var target = command.Source.Target;
        if (command.Text("mode") is not { } mode)
        {
            await command.Reply(
                "Current channel mode: "
                    + (SessionWait.Text(manager.ChannelBinding(target)?["mode"]) ?? "normal")
            );
            return;
        }
        manager.SetChannelBinding(
            target,
            "mode",
            mode == "normal" ? null : JsonValue.Create("send-only")
        );
        await command.Reply("✅ Channel mode set to " + mode);
    }

    private async Task ChannelAllowAllAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var target = command.Source.Target;
        if (command.Text("value") is not { } value)
        {
            await command.Reply(
                "Current dangerouslyAllowAllUsers: "
                    + (
                        SessionCatalog.Flag(manager.ChannelBinding(target)?["dangerouslyAllowAllUsers"])
                            ? "yes"
                            : "no"
                    )
            );
            return;
        }
        manager.SetChannelBinding(target, "dangerouslyAllowAllUsers", JsonValue.Create(value == "yes"));
        await command.Reply("✅ dangerouslyAllowAllUsers set to " + value);
    }
}
