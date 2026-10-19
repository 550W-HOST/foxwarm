using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private ChannelAuthorization Authorization(ExternalChannelContext source) =>
        runtime.Manager.ChannelAuthorization?.Inspect(source)
        ?? throw new InvalidOperationException("External channel ingress is not initialized.");

    internal async Task HandleExternalMessageAsync(
        ExternalChannelContext source,
        ExternalChannelMessage message
    )
    {
        if (!runtime.Manager.Accepting)
            return;
        var text = message.Text;
        if (await TryExternalCommandAsync(source, text, whoamiOnly: true))
            return;
        SessionOwner? owner = null;
        var authorizedAtIngress = Authorization(source).Authorized;
        if (!authorizedAtIngress)
        {
            try
            {
                owner = await runtime.Manager.ProvisionChannelGuestAsync(source);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Channel guest provisioning failed: " + error.Message);
            }
            if (owner is null && !Authorization(source).Authorized)
            {
                await source.Reply(Authorization(source).Describe(source, unauthorized: true));
                return;
            }
        }
        if (await TryExternalCommandAsync(source, text))
            return;
        try
        {
            owner ??= await runtime.Manager.ResolveChannelAsync(source.Target);
        }
        catch (Exception error)
        {
            await source.Reply(error.Message);
            return;
        }
        IReadOnlyList<JsonObject> parts = message.Parts;
        if (authorizedAtIngress && message.MaterializeParts is { } materialize)
            try
            {
                parts = await materialize(owner);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Channel media materialization failed: " + error.Message);
            }
        if (message.IngressMetadataParts is { } metadata)
            parts = metadata.Concat(parts).ToArray();
        runtime.Manager.RecordLastChannel(owner, source);
        var sendOnly =
            SessionWait.Text(runtime.Manager.ChannelBinding(source.Target)?["mode"]) == "send-only";
        var item = new QueueItem(
            QueueItemType.User,
            SessionBoundary.ExternalChannelInput(parts, source, sendOnly),
            Source: new QueueSource(
                source.Type,
                source.Conversation,
                source.Instance,
                source.Type,
                source.Conversation,
                source.Username,
                source.Sender
            )
        );
        // Ordinary channel input uses the existing best-effort queue lane; external identity is not Session authority.
        await runtime.SubmitChannelAsync(owner, item);
    }

    private async Task<bool> TryExternalCommandAsync(
        ExternalChannelContext source,
        string text,
        bool whoamiOnly = false
    )
    {
        if (
            !string.IsNullOrWhiteSpace(source.SelfName)
            && text.StartsWith("@" + source.SelfName, StringComparison.Ordinal)
        )
        {
            var rest = text[(source.SelfName.Length + 1)..];
            if (Regex.IsMatch(rest, @"^\s+"))
                text = Regex.Replace(rest, @"^\s+", "");
        }
        var match = Regex.Match(
            text,
            @"^(?:@[a-zA-Z_\-.]+\s+)?(/[a-zA-Z_\-.]+)(?:\s+(.*))?$",
            RegexOptions.Singleline
        );
        if (!match.Success || whoamiOnly && match.Groups[1].Value != "/whoami")
            return false;
        var auth = Authorization(source);
        if (match.Groups[1].Value != "/whoami" && auth.Override && !auth.Direct && !auth.Wildcard)
            return false;
        var handled = await HandleExternalCommandAsync(
            source,
            match.Groups[1].Value,
            match.Groups[2].Success ? match.Groups[2].Value : null
        );
        if (!handled)
            await source.Reply("Unknown command: " + match.Groups[1].Value);
        return true;
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
        if (command == "/whoami")
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
        // Telegram enters here before the generic Router's override-only gate.
        var definition = ExternalCommands.Find(command);
        if (definition is null)
            return false;
        var args = string.IsNullOrWhiteSpace(rawArgs) ? [] : Regex.Split(rawArgs.Trim(), @"\s+");
        try
        {
            SessionOwner? owner = selectedOwner;
            if (definition["requiresSession"]!.GetValue<bool>() && owner is null)
            {
                var id = SessionWait.Text(
                    runtime.Manager.ChannelBinding(source.Target)?["sessionId"]
                );
                if (id is null)
                {
                    await source.Reply("No active session found.");
                    return true;
                }
                owner = await runtime.GetOwnerAsync(id);
                if (owner is null)
                {
                    await source.Reply("No active session found.");
                    return true;
                }
            }
            switch (command)
            {
                case "/help":
                    await source.Reply(ExternalCommands.Help());
                    break;
                case "/attach":
                    if (args.Length == 0)
                    {
                        await source.Reply("Usage: /attach <sessionId>");
                        break;
                    }
                    var target = await runtime.GetOwnerAsync(args[0]);
                    if (target is null)
                    {
                        await source.Reply("❌ Session `" + args[0] + "` not found.");
                        break;
                    }
                    runtime.Manager.DetachChannel(source.Target);
                    runtime.Manager.AttachChannel(source.Target, target);
                    await source.Reply(
                        "✅ Attached to session `"
                            + target.Id
                            + "`"
                            + (
                                target.Metadata().DisplayName is { } display
                                    ? " (" + display + ")"
                                    : ""
                            )
                    );
                    break;
                case "/channel":
                    await HandleChannelCommandAsync(source, args);
                    break;
                case "/session":
                    await HandleSessionAdministrationAsync(source, args, selectedOwner);
                    break;
                case "/agent":
                    await HandleAgentCommandAsync(source, args);
                    break;
                case "/skill":
                    // Generic commands with requiresSession:false receive no attached owner.
                    await HandleSkillCommandAsync(source, args, selectedOwner?.Agent ?? "main");
                    break;
                case "/timer":
                    await HandleTimerCommandAsync(source, args, owner!);
                    break;
                case "/model":
                    await HandleModelCommandAsync(source, args, owner!, child: false);
                    break;
                case "/search":
                    await HandleSearchCommandAsync(source, args, owner!);
                    break;
                case "/btw" or "/verbose" or "/delete-messages":
                    await HandleSessionEffectAsync(source, command, args, owner!);
                    break;
                case "/messages":
                    await HandleMessagesCommandAsync(source, args, owner!);
                    break;
                case "/status":
                    await source.Reply(
                        SessionWait.Text(
                            (await runtime.Manager.ObserveAsync(owner!, "session", new()))["output"]
                        )!
                    );
                    break;
                case "/node":
                    await ReplyRouteAsync(
                        source,
                        await HandleNodeCommandAsync("/node " + (rawArgs ?? ""), owner!)
                    );
                    break;
                case "/fork":
                    await HandleForkCommandAsync(source, rawArgs, owner!);
                    break;
                default:
                    await HandleTextControlAsync(source, command, args, owner!);
                    break;
            }
        }
        catch (Exception error)
        {
            var prefix = command switch
            {
                "/search" => "❌ Search failed: ",
                "/skill" => "❌ Skill show failed: ",
                "/timer" => "❌ Timer creation failed: ",
                "/agent" => args.FirstOrDefault() switch
                {
                    "create" => "❌ Failed to create agent: ",
                    "isolated" => "❌ Failed to update agent isolation: ",
                    "inherit" => "❌ Failed to update inherit: ",
                    _ => "Command error: ",
                },
                "/session" => args.FirstOrDefault() switch
                {
                    "create" => "❌ Session create failed: ",
                    "refresh-snapshot" => "❌ Snapshot refresh failed: ",
                    "rename" => "❌ Rename failed: ",
                    "compact-threshold" => "❌ Compact threshold update failed: ",
                    _ => "❌ ",
                },
                _ => "❌ ",
            };
            await source.Reply(
                error.Message.StartsWith("❌", StringComparison.Ordinal)
                    ? error.Message
                    : prefix + error.Message
            );
        }
        return true;
    }

    private static Task ReplyRouteAsync(ExternalChannelContext source, MessageRouteResult result)
    {
        var value = JsonSerializer.SerializeToNode(result.Value)!.AsObject();
        return source.Reply(
            SessionWait.Text(value["commandResponse"])
                ?? SessionWait.Text(value["error"])
                ?? "Command completed."
        );
    }

    private async Task HandleChannelCommandAsync(ExternalChannelContext source, string[] args)
    {
        var sub = args.FirstOrDefault()?.ToLowerInvariant() ?? "";
        var value = args.ElementAtOrDefault(1);
        if (sub is "mode" or "dangerously-allow-all-users" or "dangerously-allow-all-group-members")
            value = value?.ToLowerInvariant();
        var manager = runtime.Manager;
        switch (sub)
        {
            case "weixin":
                await HandleWeixinCommandAsync(source, args.Skip(1).ToArray());
                return;
            case "info":
                await source.Reply(
                    $"*Channel info*\n- channelId: `{source.Instance}`\n- channelType: `{source.Type}`\n- conversationId: `{source.Conversation}`\n- channelTargetId: `{source.Target}`\n- senderId: `{source.Sender ?? "(none)"}`"
                        + (source.Username is null ? "" : $"\n- username: `{source.Username}`")
                        + $"\n- attachedSession: `{SessionWait.Text(manager.ChannelBinding(source.Target)?["sessionId"]) ?? "(none)"}`"
                        + $"\n- mode: `{SessionWait.Text(manager.ChannelBinding(source.Target)?["mode"]) ?? "normal"}`"
                        + $"\n- dangerouslyAllowAllUsers: `{(SessionCatalog.Flag(manager.ChannelBinding(source.Target)?["dangerouslyAllowAllUsers"]) ? "yes" : "no")}`"
                );
                return;
            case "auth":
                await source.Reply(Authorization(source).Describe(source));
                return;
            case "status":
                await source.Reply(FormatChannelStatus(value));
                return;
            case "start" or "stop" or "restart":
                if (value is null)
                {
                    await source.Reply("Usage: /channel " + sub + " <channel-id>");
                    return;
                }
                var wasRunning = manager
                    .ManagedChannels!.Statuses()
                    .OfType<JsonObject>()
                    .Any(row =>
                        SessionWait.Text(row["channelId"]) == value
                        && SessionCatalog.Flag(row["running"])
                    );
                await manager.ManagedChannels.ChangeAsync(sub, value);
                var verb =
                    sub == "restart" ? "restarted"
                    : sub == "start"
                        ? wasRunning ? "was already running"
                            : "started"
                    : wasRunning ? "stopped"
                    : "was already stopped";
                await source.Reply($"✅ Channel `{value}` {verb}.\n" + FormatChannelStatus(value));
                return;
            case "mode":
                if (value is null)
                {
                    await source.Reply(
                        "Current channel mode: "
                            + (
                                SessionWait.Text(manager.ChannelBinding(source.Target)?["mode"])
                                ?? "normal"
                            )
                    );
                    return;
                }
                if (value is not ("normal" or "send-only" or "push-only"))
                {
                    await source.Reply("Invalid mode. Use: send-only or normal");
                    return;
                }
                manager.SetChannelBinding(
                    source.Target,
                    "mode",
                    value == "normal" ? null : JsonValue.Create("send-only")
                );
                await source.Reply(
                    "✅ Channel mode set to " + (value == "normal" ? "normal" : "send-only")
                );
                return;
            case "dangerously-allow-all-users" or "dangerously-allow-all-group-members":
                if (value is null)
                {
                    await source.Reply(
                        "Current dangerouslyAllowAllUsers: "
                            + (
                                SessionCatalog.Flag(
                                    manager
                                        .ChannelBinding(source.Target)
                                        ?["dangerouslyAllowAllUsers"]
                                )
                                    ? "yes"
                                    : "no"
                            )
                    );
                    return;
                }
                if (value is not ("yes" or "no"))
                {
                    await source.Reply("Invalid value. Use: yes or no");
                    return;
                }
                manager.SetChannelBinding(
                    source.Target,
                    "dangerouslyAllowAllUsers",
                    JsonValue.Create(value == "yes")
                );
                await source.Reply("✅ dangerouslyAllowAllUsers set to " + value);
                return;
        }
        await source.Reply(
            "Usage: /channel info|auth|status|start|stop|restart|mode|weixin|dangerously-allow-all-users"
        );
    }

    private string FormatChannelStatus(string? filter)
    {
        var rows = (runtime.Manager.ManagedChannels?.Statuses() ?? new JsonArray())
            .OfType<JsonObject>()
            .ToArray();
        if (filter is not null)
            rows = rows.Any(row => SessionWait.Text(row["channelId"]) == filter)
                ? rows.Where(row => SessionWait.Text(row["channelId"]) == filter).ToArray()
                : rows.Where(row => SessionWait.Text(row["type"]) == filter).ToArray();
        static string Flag(JsonNode? value) => SessionCatalog.Flag(value) ? "yes" : "no";
        return rows.Length == 0
            ? "No known channel runtime status found."
            : "*Channel runtime status*\n"
                + string.Join(
                    "\n",
                    rows.Select(row =>
                        $"- `{row["channelId"]}` (type=`{row["type"]}`): running=`{Flag(row["running"])}`, managed=`{Flag(row["managed"])}`, configured=`{Flag(row["configured"])}`, enabled=`{Flag(row["enabled"])}`"
                        + (
                            row["details"] is JsonArray details && details.Count > 0
                                ? "; " + string.Join("; ", details.Select(SessionWait.Text))
                                : ""
                        )
                        + (
                            SessionWait.Text(row["lastError"]) is { } error
                                ? "; lastError=" + error
                                : ""
                        )
                    )
                );
    }
}
