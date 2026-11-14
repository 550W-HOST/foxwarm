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
            ),
            OpenFields: new JsonObject { ["userInput"] = true }
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
        if (
            !TryReadCommand(text, out var command, out var rawArgs, allowMention: true)
            || whoamiOnly && !IsWhoami(command, rawArgs)
        )
            return false;
        var auth = Authorization(source);
        if (!IsWhoami(command, rawArgs) && auth.Override && !auth.Direct && !auth.Wildcard)
            return false;
        return await HandleExternalCommandAsync(source, command, rawArgs);
    }

    private static Task ReplyRouteAsync(ExternalChannelContext source, MessageRouteResult result)
    {
        var value = JsonData.SerializeToNode(result.Value)!.AsObject();
        return source.Reply(
            SessionWait.Text(value["commandResponse"])
                ?? SessionWait.Text(value["error"])
                ?? "Command completed."
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
