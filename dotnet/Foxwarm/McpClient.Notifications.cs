using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol.Protocol;
using SdkClient = ModelContextProtocol.Client.McpClient;

namespace Foxwarm;

internal sealed partial class McpClient
{
    internal const string NotificationCapabilityName = "foxwarm/session-notifications";
    internal const string SessionMessageMethod = "notifications/foxwarm/session_message";
    internal const int MaxNotificationBytes = 1024 * 1024 - 4096;
    private bool notificationsStopped;
    internal TimeSpan NotificationPingInterval { get; set; } = TimeSpan.FromMinutes(5);

    internal static Dictionary<string, object> NotificationCapability() => new()
    {
        [NotificationCapabilityName] = JsonSerializer.SerializeToElement(new { version = 1 }),
    };

    internal static bool SupportsNotifications(IDictionary<string, object>? capabilities) =>
        capabilities?.TryGetValue(NotificationCapabilityName, out var raw) == true
        && raw is JsonElement value && value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty("version", out var version)
        && version.ValueKind == JsonValueKind.Number
        && version.TryGetInt32(out var number) && number == 1;

    private sealed record Reception(Func<CancellationToken, Task> Authorize, Action Check, Func<string, string, Action, Task> Receive);

    private void RequireReception(PoolEntry entry, Reception reception, bool physical = false)
    {
        lock (poolGate)
        {
            var owner = entry.Key.Owner;
            if (notificationsStopped || entry.Invalid || entry.Token.IsCancellationRequested
                || owner is null || owner.Entry.Retired || owner.McpGeneration != entry.Key.Generation
                || pool.GetValueOrDefault(entry.Key) != entry || !ReferenceEquals(entry.Reception, reception)
                || physical && !entry.Receiver.Receiving)
                throw new InvalidOperationException("MCP notification receiver is unavailable.");
        }
        reception.Check();
    }

    internal Task<JsonObject> ManageNotificationsAsync(
        SessionOwner owner, long generation, string server, string action,
        Func<CancellationToken, Task> authorize, Action check,
        Func<string, string, Action, Task> receive, CancellationToken token)
        => RunAsync(async current =>
        {
            if (action is "stop" or "status")
            {
                Task closed = Task.CompletedTask;
                JsonObject status;
                lock (poolGate)
                {
                    var entry = pool.GetValueOrDefault(new(server, owner, generation, null));
                    if (action == "stop" && entry is not null)
                    {
                        InvalidateEntry(entry);
                        closed = entry.Closed ?? Task.CompletedTask;
                    }
                    status = Status(server, action == "stop" ? null : entry);
                }
                await closed;
                return status;
            }
            if (action != "start")
                throw new InvalidDataException("Invalid notification action.");
            await authorize(current);
            var config = configuration.Get(server);
            if (SessionWait.Text(config["transport"]) != "streamable-http")
                throw new InvalidOperationException("Notifications require a Session-owned Streamable HTTP connection.");
            return await WithClientAsync(server, current, owner, generation, async (client, _, request) =>
            {
                if (!SupportsNotifications(client.ServerCapabilities.Experimental))
                    throw new InvalidOperationException("MCP server does not support Foxwarm message notifications.");
                PoolEntry entry;
                lock (poolGate)
                    entry = pool.GetValueOrDefault(new(server, owner, generation, null))
                        ?? throw new InvalidOperationException("MCP connection is unavailable.");
                await entry.Receiver.Ready.WaitAsync(TimeSpan.FromSeconds(60), request);
                await authorize(request);
                check();
                lock (poolGate)
                {
                    if (notificationsStopped || entry.Invalid || !entry.Receiver.Receiving)
                        throw new InvalidOperationException("MCP notification stream is unavailable.");
                    if (entry.Reception is null)
                    {
                        var reception = new Reception(authorize, check, receive);
                        entry.Reception = reception;
                        entry.Idle?.Cancel();
                        entry.Idle = null;
                        TrackClosing(PingNotificationsAsync(entry, reception, client));
                    }
                    return Status(server, entry);
                }
            });
        }, token);

    private static JsonObject Status(string server, PoolEntry? entry) => new()
    {
        ["server"] = server,
        ["state"] = entry?.Reception is null ? "stopped" : entry.Invalid ? "unavailable"
            : entry.Receiver.Receiving ? "receiving" : "disconnected",
    };

    private async ValueTask ReceiveNotificationAsync(PoolEntry entry, JsonRpcNotification notification, CancellationToken token)
    {
        Reception? reception;
        lock (poolGate)
            reception = entry.Reception;
        if (reception is null || notification.Params is not JsonObject args
            || args.Any(pair => pair.Key is not ("message" or "endpoint"))
            || SessionWait.Text(args["message"]) is not string text || SessionGoal.Trim(text).Length == 0
            || Encoding.UTF8.GetByteCount(text) > MaxNotificationBytes
            || SessionWait.Text(args["endpoint"]) is not string endpoint || endpoint.Length > 256)
            return;
        var streamCredentials = entry.Receiver.Credentials;
        try
        {
            await reception.Authorize(token);
            RequireReception(entry, reception);
            if (EchoesCredential(args, streamCredentials.Concat(ExternalCredentials(entry.Config)).ToArray()))
                return;
            await reception.Receive(text, endpoint, () => RequireReception(entry, reception));
        }
        catch
        {
            // External input which no longer passes admission is dropped, never retried or reclassified.
        }
    }

    private async Task PreflightReplyAsync(SdkClient client, string name, JsonObject args, CancellationToken token)
    {
        if (name != "foxwarm_session" || SessionWait.Text(args["action"]) != "send"
            || !SupportsNotifications(client.ServerCapabilities.Experimental))
            return;
        static bool? Flag(JsonNode? node) => node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;
        var allow = Flag(args["allowReply"]);
        var legacy = Flag(args["reply"]);
        if (allow is not null && legacy is not null && allow != legacy)
            throw new InvalidOperationException("allowReply and legacy reply must agree when both are provided. No tool call was sent.");
        if (allow != true && legacy != true)
            return;
        PoolEntry? entry;
        Reception? reception;
        lock (poolGate)
        {
            entry = pool.Values.FirstOrDefault(item => item.Connected.Task.IsCompletedSuccessfully && ReferenceEquals(item.Connected.Task.Result.Client, client));
            reception = entry?.Reception;
        }
        if (entry is null || reception is null)
            throw new InvalidOperationException("Start mcp_notifications for this Session before requesting explicit replies. No tool call was sent.");
        await reception.Authorize(token);
        RequireReception(entry, reception, physical: true);
    }

    private async Task PingNotificationsAsync(PoolEntry entry, Reception reception, SdkClient client)
    {
        try
        {
            while (true)
            {
                await Task.Delay(NotificationPingInterval, entry.Token);
                await reception.Authorize(entry.Token);
                RequireReception(entry, reception);
                try
                {
                    using var ping = CancellationTokenSource.CreateLinkedTokenSource(entry.Token);
                    ping.CancelAfter(TimeSpan.FromSeconds(60));
                    await client.SendRequestAsync(new JsonRpcRequest { Id = new RequestId(Guid.NewGuid().ToString("N")), Method = "ping" }, ping.Token);
                }
                catch when (!entry.Token.IsCancellationRequested) { }
            }
        }
        catch
        {
            lock (poolGate)
                InvalidateEntry(entry);
        }
    }

    internal void StopNotificationProducer()
    {
        lock (poolGate)
        {
            notificationsStopped = true;
            foreach (var entry in pool.Values.Where(entry => entry.Reception is not null).ToArray())
                InvalidateEntry(entry, drainActive: true);
        }
    }
}
