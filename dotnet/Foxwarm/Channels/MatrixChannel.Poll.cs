using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class MatrixChannel
{
    private async Task PollAsync(bool threadNotifications)
    {
        try
        {
            await StartupRequestAsync(HttpMethod.Get, "_matrix/client/v3/pushrules/", null);
            var filter = new JsonObject();
            if (threadNotifications)
                filter["room"] = new JsonObject
                {
                    ["timeline"] = new JsonObject { ["unread_thread_notifications"] = true },
                };
            var created = await StartupRequestAsync(
                HttpMethod.Post,
                "_matrix/client/v3/user/" + Encode(user) + "/filter",
                filter
            );
            var filterId =
                SessionWait.Text(created["filter_id"])
                ?? throw new InvalidDataException("Matrix filter has no filter_id.");
            var initial = (JsonObject)filter.DeepClone();
            initial["room"] ??= new JsonObject();
            initial["room"]!["timeline"] ??= new JsonObject();
            initial["room"]!["timeline"]!["limit"] = 10;
            var position = cursors is null ? null : await cursors.ReadAsync(id, Account);
            RestoreEncryption(position);
            string? cursor = SessionWait.Text(position?["next_batch"]);
            resumed = cursor is not null;
            var catchingUp = true;
            var reconnecting = false;
            while (!stopping.IsCancellationRequested)
            {
                JsonObject sync;
                try
                {
                    var queryTimeout = catchingUp || reconnecting ? 0 : 30000;
                    var query =
                        "filter="
                        + Uri.EscapeDataString(cursor is null ? initial.ToJsonText() : filterId)
                        + "&timeout="
                        + queryTimeout
                        + "&org.matrix.msc4222.use_state_after=true"
                        + (
                            cursor is null
                                ? "&_cacheBuster=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                                : "&since=" + Uri.EscapeDataString(cursor)
                        );
                    sync = await RequestAsync(
                        HttpMethod.Get,
                        "_matrix/client/v3/sync?" + query,
                        null,
                        stopping.Token,
                        TimeSpan.FromMilliseconds(queryTimeout + 80000)
                    );
                }
                catch (Exception error) when (!stopping.IsCancellationRequested)
                {
                    if (
                        error is MatrixApiException { Code: "M_UNKNOWN_TOKEN" }
                        || ChannelFailure.Refused(error)
                    )
                        throw;
                    health.Fail(SyncPath, error);
                    await RecoverAsync();
                    reconnecting = true;
                    continue;
                }
                health.Recover(SyncPath);
                try
                {
                    var gate = sessions?.ScheduledProducers;
                    using var admission = gate?.TryEnterProducer();
                    if (gate is not null && admission is null) return;
                    var next = SessionWait.Text(sync["next_batch"]);
                    reconnecting = false;
                    catchingUp = (sync["to_device"]?["events"] as JsonArray)?.Count > 0;
                    foreach (
                        var (room, raw) in sync["rooms"]?["invite"] as JsonObject ?? new JsonObject()
                    )
                        await ProcessRoomStateAsync(room, raw?["invite_state"]?["events"] as JsonArray);
                    foreach (var section in new[] { "join", "leave" })
                    foreach (
                        var (room, raw) in sync["rooms"]?[section] as JsonObject ?? new JsonObject()
                    )
                    {
                        await ProcessRoomStateAsync(room, raw?["state"]?["events"] as JsonArray);
                        await ProcessRoomStateAsync(
                            room,
                            raw?["org.matrix.msc4222.state_after"]?["events"] as JsonArray
                        );
                        foreach (
                            var item in (
                                raw?["timeline"]?["events"] as JsonArray ?? []
                            ).OfType<JsonObject>()
                        )
                        {
                            await ProcessRoomStateAsync(room, new JsonArray(item.DeepClone()));
                            await ProcessTimelineAsync(room, item);
                        }
                    }
                    if (cursors is not null && next is not null)
                    {
                        var rooms = EncryptedRoomList();
                        await cursors.SaveAsync(id, Account, new JsonObject { ["next_batch"] = next, ["encryptedRooms"] = rooms });
                    }
                    cursor = next;
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    // Retain since on failed Session admission or checkpoint. Prior messages
                    // are recognized by their durable receipts if this batch is read again.
                    health.Log(error);
                    await delay(TimeSpan.FromSeconds(2), stopping.Token);
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            // The loop has ended: sync stays failed until the channel restarts.
            health.Fail(SyncPath, error);
        }
    }

    private async Task<JsonObject> StartupRequestAsync(
        HttpMethod method,
        string path,
        JsonObject? body
    )
    {
        while (true)
        {
            try
            {
                var result = await RequestAsync(method, path, body, stopping.Token);
                health.Recover(SyncPath);
                return result;
            }
            catch (Exception error) when (!stopping.IsCancellationRequested)
            {
                if (
                    error is MatrixApiException { Code: "M_UNKNOWN_TOKEN" }
                    || ChannelFailure.Refused(error)
                )
                    throw;
                health.Fail(SyncPath, error);
                await RecoverAsync();
            }
        }
    }

    private async Task RecoverAsync()
    {
        await delay(TimeSpan.FromMilliseconds(Random.Shared.Next(2000, 7000)), stopping.Token);
        while (!stopping.IsCancellationRequested)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            try
            {
                // SDK sync keepalives are deliberately unauthenticated.
                using var response = await http.GetAsync(
                    new Uri(homeserver.ToString().TrimEnd('/') + "/_matrix/client/versions"),
                    timeout.Token
                );
                if (response.IsSuccessStatusCode)
                    return;
                if ((int)response.StatusCode is 400 or 404)
                {
                    await delay(TimeSpan.FromSeconds(2), stopping.Token);
                    return;
                }
            }
            catch (Exception error)
                when (!stopping.IsCancellationRequested && !ChannelFailure.Refused(error)) { }
            await delay(TimeSpan.FromMilliseconds(Random.Shared.Next(5000, 10000)), stopping.Token);
        }
        stopping.Token.ThrowIfCancellationRequested();
    }

    private readonly Dictionary<string, string> memberships = new(StringComparer.Ordinal);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<
        string,
        byte
    > encryptedRooms = new(StringComparer.Ordinal);

    private JsonArray EncryptedRoomList() => new(encryptedRooms.Keys.Order(StringComparer.Ordinal)
        .Select(room => (JsonNode?)JsonValue.Create(room)).ToArray());

    private async Task ProcessRoomStateAsync(string room, JsonArray? events)
    {
        foreach (var item in (events ?? []).OfType<JsonObject>())
        {
            if (
                SessionWait.Text(item["type"]) == "m.room.encryption"
                && SessionWait.Text(item["state_key"]) == ""
            )
            {
                if (encryptedRooms.TryAdd(room, 0) && cursors is not null)
                {
                    // A later event may fail. Retain encryption knowledge independently of
                    // advancing that batch's cursor, before callers can send after a restart.
                    var current = await cursors.ReadAsync(id, Account) ?? new JsonObject();
                    current["encryptedRooms"] = EncryptedRoomList();
                    await cursors.SaveAsync(id, Account, current);
                }
            }
            if (
                SessionWait.Text(item["type"]) != "m.room.member"
                || SessionWait.Text(item["state_key"]) != user
            )
                continue;
            var membership = SessionWait.Text(item["content"]?["membership"]) ?? "";
            if (memberships.GetValueOrDefault(room) == membership)
                continue;
            memberships[room] = membership;
            if (membership == "invite")
                _ = ObserveAsync(
                    RequestAsync(
                        HttpMethod.Post,
                        "_matrix/client/v3/join/" + Encode(room),
                        new JsonObject(),
                        CancellationToken.None
                    )
                );
        }
    }

    internal async Task ProcessTimelineAsync(
        string room,
        JsonObject item,
        bool toStartOfTimeline = false
    )
    {
        if (
            toStartOfTimeline
            || SessionWait.Text(item["type"]) != "m.room.message"
            || SessionWait.Text(item["sender"]) == user
        )
            return;
        if (!resumed && SessionWait.Number(item["origin_server_ts"]) is { } timestamp && timestamp < startTime)
            return;
        var eventId = SessionWait.Text(item["event_id"]) ?? "";
        if (eventId.Length > 0 && processed.Contains(eventId)) return;
        void Remember()
        {
            if (eventId.Length == 0 || !processed.Add(eventId)) return;
            processedOrder.Enqueue(eventId);
            if (processedOrder.Count > 1000) processed.Remove(processedOrder.Dequeue());
        }
        if (SessionWait.Text(item["sender"]) is not { Length: > 0 } sender)
            return;
        var content = item["content"] as JsonObject ?? new JsonObject();
        var context = new ExternalChannelContext(
            id,
            "matrix",
            room,
            sender,
            sender,
            text => SendTextAsync(room, text, false, CancellationToken.None)
        ) { Polled = true, Receipt = eventId.Length > 0 ? ChannelCursors.Receipt("matrix", id, Account, eventId) : null };
        ExternalChannelMessage message;
        switch (SessionWait.Text(content["msgtype"]))
        {
            case "m.text":
                message = new([new JsonObject { ["text"] = content["body"]?.DeepClone() }]);
                break;
            case "m.image" or "m.file":
                var image = SessionWait.Text(content["msgtype"]) == "m.image";
                if (MediaUri(SessionWait.Text(content["url"])) is not { } media)
                {
                    health.Log(new InvalidDataException("Invalid Matrix media URI."));
                    Remember();
                    return;
                }
                // Source fetches eagerly before Router authorization and does not attach the access token.
                try
                {
                    using var response = await http.GetAsync(media, HttpCompletionOption.ResponseHeadersRead, cursors?.Closing ?? default);
                    response.EnsureSuccessStatusCode();
                    var name = !image ? SessionWait.Text(content["filename"]) : null;
                    if (string.IsNullOrEmpty(name))
                        name = SessionWait.Text(content["body"]);
                    if (string.IsNullOrEmpty(name))
                        name = image ? "matrix-image" : "matrix-file";
                    var mime = SessionWait.Text(content["info"]?["mimetype"]);
                    if (string.IsNullOrEmpty(mime))
                        mime = image ? "image/jpeg" : "application/octet-stream";
                    message = await sessions.ReceiveRemoteChannelFileAsync(
                        "matrix",
                        room,
                        () => sessions.ReadChannelBodyAsync(response.Content, cursors?.Closing ?? default),
                        name,
                        mime,
                        "",
                        CancellationToken.None,
                        image
                    );
                }
                catch (Exception error) when (ChannelFailure.RejectedMedia(error))
                {
                    health.Log(error);
                    Remember();
                    return;
                }
                break;
            default:
                Remember();
                return;
        }
        await router.HandleExternalMessageAsync(context, message);
        Remember();
    }
}
