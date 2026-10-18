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
            string? cursor = null;
            var catchingUp = true;
            var reconnecting = false;
            while (!stopping.IsCancellationRequested)
            {
                JsonObject sync;
                try
                {
                    var query =
                        "filter="
                        + Uri.EscapeDataString(cursor is null ? initial.ToJsonString() : filterId)
                        + "&timeout="
                        + (catchingUp || reconnecting ? "0" : "30000")
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
                        stopping.Token
                    );
                }
                catch (Exception error) when (!stopping.IsCancellationRequested)
                {
                    if (error is MatrixApiException { Code: "M_UNKNOWN_TOKEN" })
                        throw;
                    log(error);
                    await RecoverAsync();
                    reconnecting = true;
                    continue;
                }
                cursor = SessionWait.Text(sync["next_batch"]);
                reconnecting = false;
                catchingUp = (sync["to_device"]?["events"] as JsonArray)?.Count > 0;
                foreach (
                    var (room, raw) in sync["rooms"]?["invite"] as JsonObject ?? new JsonObject()
                )
                    ProcessMembership(room, raw?["invite_state"]?["events"] as JsonArray);
                foreach (var section in new[] { "join", "leave" })
                foreach (
                    var (room, raw) in sync["rooms"]?[section] as JsonObject ?? new JsonObject()
                )
                {
                    ProcessMembership(room, raw?["state"]?["events"] as JsonArray);
                    ProcessMembership(
                        room,
                        raw?["org.matrix.msc4222.state_after"]?["events"] as JsonArray
                    );
                    foreach (
                        var item in (
                            raw?["timeline"]?["events"] as JsonArray ?? []
                        ).OfType<JsonObject>()
                    )
                    {
                        ProcessMembership(room, new JsonArray(item.DeepClone()));
                        // The SDK event emitter does not join async application timeline handlers.
                        _ = ObserveAsync(ProcessTimelineAsync(room, item));
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error)
        {
            log(error);
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
                return await RequestAsync(method, path, body, stopping.Token);
            }
            catch (Exception error) when (!stopping.IsCancellationRequested)
            {
                if (error is MatrixApiException { Code: "M_UNKNOWN_TOKEN" })
                    throw;
                log(error);
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
            catch (Exception) when (!stopping.IsCancellationRequested) { }
            await delay(TimeSpan.FromMilliseconds(Random.Shared.Next(5000, 10000)), stopping.Token);
        }
        stopping.Token.ThrowIfCancellationRequested();
    }

    private readonly Dictionary<string, string> memberships = new(StringComparer.Ordinal);

    private void ProcessMembership(string room, JsonArray? events)
    {
        foreach (var item in (events ?? []).OfType<JsonObject>())
        {
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
        if (SessionWait.Number(item["origin_server_ts"]) is { } timestamp && timestamp < startTime)
            return;
        var eventId = SessionWait.Text(item["event_id"]) ?? "";
        if (!processed.Add(eventId))
            return;
        processedOrder.Enqueue(eventId);
        if (processedOrder.Count > 1000)
            processed.Remove(processedOrder.Dequeue());
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
        );
        IReadOnlyList<JsonObject> parts;
        switch (SessionWait.Text(content["msgtype"]))
        {
            case "m.text":
                parts = [new JsonObject { ["text"] = content["body"]?.DeepClone() }];
                break;
            case "m.image" or "m.file":
                var image = SessionWait.Text(content["msgtype"]) == "m.image";
                var media =
                    MediaUri(SessionWait.Text(content["url"]))
                    ?? throw new InvalidDataException("Invalid Matrix media URI.");
                // Source fetches eagerly before Router authorization and does not attach the access token.
                using (var response = await http.GetAsync(media))
                {
                    var bytes = await response.Content.ReadAsByteArrayAsync();
                    var name = !image ? SessionWait.Text(content["filename"]) : null;
                    if (string.IsNullOrEmpty(name))
                        name = SessionWait.Text(content["body"]);
                    if (string.IsNullOrEmpty(name))
                        name = image ? "matrix-image" : "matrix-file";
                    var mime = SessionWait.Text(content["info"]?["mimetype"]);
                    if (string.IsNullOrEmpty(mime))
                        mime = image ? "image/jpeg" : "application/octet-stream";
                    parts = await sessions.SaveInboundChannelFileAsync(
                        "matrix",
                        room,
                        bytes,
                        name,
                        mime,
                        "",
                        CancellationToken.None,
                        image
                    );
                }
                break;
            default:
                return;
        }
        await router.HandleExternalMessageAsync(context, new(parts));
    }
}
