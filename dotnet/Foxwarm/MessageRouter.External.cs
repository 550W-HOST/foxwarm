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
        runtime.Manager.RecordLastChannel(owner, source);
        var sendOnly =
            SessionWait.Text(runtime.Manager.ChannelBinding(source.Target)?["mode"]) == "send-only";
        var item = new QueueItem(
            QueueItemType.User,
            SessionBoundary.ExternalChannelInput(message.Parts, source, sendOnly),
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
        string? rawArgs
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
        var auth = Authorization(source);
        if (!auth.Authorized)
        {
            await source.Reply(auth.Describe(source, unauthorized: true));
            return true;
        }
        // Telegram's direct command hook enters the same Source CommandHandler before Router command detection.
        if (!ExternalCommands.Descriptions.ContainsKey(command.TrimStart('/')))
            return false;
        var args = string.IsNullOrWhiteSpace(rawArgs) ? [] : Regex.Split(rawArgs.Trim(), @"\s+");
        try
        {
            switch (command)
            {
                case "/help":
                    await source.Reply(
                        string.Join(
                            "\n",
                            ExternalCommands.Descriptions.Select(pair =>
                                "/" + pair.Key + ": " + pair.Value
                            )
                        )
                    );
                    return true;
                case "/attach":
                    if (args.Length == 0)
                    {
                        await source.Reply("Usage: /attach <sessionId>");
                        return true;
                    }
                    var target = await runtime.GetOwnerAsync(args[0]);
                    if (target is null)
                    {
                        await source.Reply("❌ Session `" + args[0] + "` not found.");
                        return true;
                    }
                    // Source detaches first. A failed durable attach does not promise to recover the former binding.
                    runtime.Manager.DetachChannel(source.Target);
                    runtime.Manager.AttachChannel(source.Target, target);
                    await source.Reply("✅ Attached to session `" + target.Id + "`");
                    return true;
                case "/channel":
                    await HandleChannelCommandAsync(source, args);
                    return true;
                case "/session":
                    if (await HandleExternalSessionCommandAsync(source, args))
                        return true;
                    break;
                case "/status":
                    var bound = SessionWait.Text(
                        runtime.Manager.ChannelBinding(source.Target)?["sessionId"]
                    );
                    var active = bound is null ? null : await runtime.GetOwnerAsync(bound);
                    await source.Reply(
                        active is null
                            ? "No active session found."
                            : JsonSerializer.Serialize(active.State())
                    );
                    return true;
            }
            var sessionId = SessionWait.Text(
                runtime.Manager.ChannelBinding(source.Target)?["sessionId"]
            );
            if (sessionId is null)
            {
                await source.Reply("No active session found.");
                return true;
            }
            var text = command + (rawArgs is null ? "" : " " + rawArgs);
            var result = await HandleMessageAsync(new(sessionId, source.Type), new(text, null));
            await source.Reply(JsonSerializer.Serialize(result.Value));
        }
        catch (Exception error)
        {
            var safe =
                runtime.Manager.Models.ConfigurationOwner?.SafeAppError(error) ?? error.Message;
            await source.Reply("Command error: " + safe);
        }
        return true;
    }

    private async Task HandleChannelCommandAsync(ExternalChannelContext source, string[] args)
    {
        var sub = args.FirstOrDefault()?.ToLowerInvariant() ?? "";
        var value = args.ElementAtOrDefault(1);
        var manager = runtime.Manager;
        switch (sub)
        {
            case "weixin":
                await HandleWeixinCommandAsync(source, args.Skip(1).ToArray());
                return;
            case "info":
                await source.Reply(
                    $"channelId: `{source.Instance}`\nchannelType: `{source.Type}`\nconversationId: `{source.Conversation}`\nchannelTargetId: `{source.Target}`"
                );
                return;
            case "auth":
                await source.Reply(Authorization(source).Describe(source));
                return;
            case "status":
                var statuses = manager.ManagedChannels?.Statuses() ?? new JsonArray();
                await source.Reply(
                    value is null
                        ? statuses.ToJsonString()
                        : new JsonArray(
                            statuses
                                .OfType<JsonObject>()
                                .Where(status => SessionWait.Text(status["channelId"]) == value)
                                .Select(status => status.DeepClone())
                                .ToArray()
                        ).ToJsonString()
                );
                return;
            case "start" or "stop" or "restart":
                if (value is null)
                {
                    await source.Reply("Usage: /channel " + sub + " <channel-id>");
                    return;
                }
                await manager.ManagedChannels!.ChangeAsync(sub, value);
                await source.Reply("✅ Channel `" + value + "` " + sub + " completed.");
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

    private async Task<bool> HandleExternalSessionCommandAsync(
        ExternalChannelContext source,
        string[] args
    )
    {
        var sub = args.FirstOrDefault();
        SessionOwner created;
        switch (sub)
        {
            case "new":
                created = await runtime.Manager.CreateAsync();
                break;
            case "create":
                if (args.Length < 3)
                {
                    await source.Reply("Usage: /session create <agent> <session>");
                    return true;
                }
                if (args.Length > 3)
                    throw new InvalidDataException(
                        "Session create flags are not implemented on this server."
                    );
                created = await runtime.Manager.CreateNamedAsync(args[1], args[2], null, null);
                break;
            case "fork":
                var id = SessionWait.Text(
                    runtime.Manager.ChannelBinding(source.Target)?["sessionId"]
                );
                if (id is null)
                {
                    await source.Reply("❌ No active session to fork.");
                    return true;
                }
                created = await runtime.ForkAsync(id, args.ElementAtOrDefault(1));
                break;
            case null or "list":
                await source.Reply(
                    string.Join(
                        "\n",
                        runtime.ListSessions().Select(row => SessionWait.Text(row["id"]))
                    )
                );
                return true;
            default:
                return false;
        }
        runtime.Manager.DetachChannel(source.Target);
        runtime.Manager.AttachChannel(source.Target, created);
        await source.Reply("✅ Created and attached to session `" + created.Id + "`");
        return true;
    }
}
