// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2; see THIRD_PARTY_NOTICES.md.
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class WeixinChannel : IManagedChannel
{
    private readonly string id;
    private readonly string baseUrl;
    private readonly string token;
    private readonly string? routeTag;
    private readonly int timeout;
    private readonly MessageRouter router;
    private readonly WeixinApi api;
    private readonly Action<Exception> log;
    private volatile bool stopped;
    private Task? polling;
    private string cursor = "";

    internal WeixinChannel(string id, JsonObject config, MessageRouter router, WeixinApi api, Action<Exception> log)
    {
        this.id = id;
        this.router = router;
        this.api = api;
        this.log = log;
        baseUrl = SessionWait.Text(config["baseUrl"])?.Trim() is { Length: > 0 } url ? url : WeixinApi.DefaultBaseUrl;
        token = SessionWait.Text(config["token"])?.Trim() ?? "";
        routeTag = SessionWait.Text(config["routeTag"])?.Trim();
        timeout = (int)(SessionWait.Number(config["longPollTimeoutMs"]) ?? 35000);
    }

    public RegisteredChannel Transport => new("weixin", (user, text, _, _) => api.SendAsync(baseUrl, token, routeTag, user, text), Typing: (_, _) => Task.CompletedTask);

    public Task StartAsync()
    {
        if (token.Length == 0) throw new InvalidDataException("Weixin token is required");
        polling ??= PollAsync();
        return Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        stopped = true;
        // Source's outer-loop signal is not passed to fetch or its backoff delay.
        if (polling is not null) await polling;
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    private async Task PollAsync()
    {
        var failures = 0;
        while (!stopped)
        {
            try
            {
                var response = await api.UpdatesAsync(baseUrl, token, routeTag, cursor, timeout);
                var ret = SessionWait.Number(response["ret"]) ?? 0;
                var code = SessionWait.Number(response["errcode"]) ?? 0;
                if (ret != 0 || code != 0)
                    throw new IOException(ret == -14 || code == -14
                        ? "Weixin session expired; re-run /channel weixin login and restart foxwarm."
                        : $"Weixin getUpdates failed: ret={ret} errcode={code} errmsg={SessionWait.Text(response["errmsg"]) ?? ""}");
                failures = 0;
                if (SessionWait.Text(response["get_updates_buf"]) is { Length: > 0 } next) cursor = next;
                foreach (var message in (response["msgs"] as JsonArray ?? []).OfType<JsonObject>())
                    await HandleAsync(message);
            }
            catch (Exception error)
            {
                if (stopped) return;
                failures++;
                log(error);
                await api.DelayAsync(failures >= 3 ? 30000 : 2000);
            }
        }
    }

    private async Task HandleAsync(JsonObject message)
    {
        var user = SessionWait.Text(message["from_user_id"])?.Trim();
        if (string.IsNullOrEmpty(user)) return;
        if (SessionWait.Text(message["context_token"]) is { Length: > 0 } context) api.CacheContext(user, context);
        var source = new ExternalChannelContext(id, "weixin", user, user, user, text => api.SendAsync(baseUrl, token, routeTag, user, text));
        await router.HandleExternalMessageAsync(source, new(WeixinInbound.Parts(message)));
    }
}

internal static class WeixinInbound
{
    private static bool Media(JsonNode? item) => SessionWait.Number(item?["type"]) is 2 or 3 or 4 or 5;
    private static string String(JsonNode? value) => value switch
    {
        null => "", JsonObject => "[object Object]", JsonArray array => string.Join(",", array.Select(String)),
        _ => SessionWait.Text(value) ?? value.ToJsonString(),
    };

    private static string Body(JsonArray? items)
    {
        foreach (var item in (items ?? []).OfType<JsonObject>())
        {
            if (SessionWait.Number(item["type"]) == 1 && item["text_item"]?["text"] is { } textNode)
            {
                var text = String(textNode);
                var reference = item["ref_msg"] as JsonObject;
                if (reference is null || Media(reference["message_item"])) return text;
                var quoted = new List<string>();
                if (SessionWait.Text(reference["title"]) is { Length: > 0 } title) quoted.Add(title);
                if (reference["message_item"] is { } referenced)
                {
                    var nested = Body(new JsonArray(referenced.DeepClone()));
                    if (nested.Length > 0) quoted.Add(nested);
                }
                return quoted.Count > 0 ? "[引用: " + string.Join(" | ", quoted) + "]\n" + text : text;
            }
            if (SessionWait.Number(item["type"]) == 3 && SessionWait.Text(item["voice_item"]?["text"]) is { Length: > 0 } voice) return voice;
        }
        return "";
    }

    internal static IReadOnlyList<JsonObject> Parts(JsonObject message)
    {
        var items = message["item_list"] as JsonArray;
        var text = Body(items);
        if (text.Length == 0)
            text = SessionWait.Number((items ?? []).FirstOrDefault(Media)?["type"]) switch
            {
                2 => "[Weixin image message received. Media handling is not supported in this MVP yet.]",
                5 => "[Weixin video message received. Media handling is not supported in this MVP yet.]",
                4 => "[Weixin file message received. File handling is not supported in this MVP yet.]",
                3 => "[Weixin voice message received. Voice handling is not supported in this MVP yet.]",
                _ => "[Weixin unsupported message received.]",
            };
        return [new JsonObject { ["text"] = text }];
    }
}
