// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2; see THIRD_PARTY_NOTICES.md.
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed record WeixinLoginResult(bool Connected, string Message, string? BotToken = null, string? UserId = null, string? BaseUrl = null);

internal sealed partial class WeixinApi
{
    private sealed record ActiveLogin(string QrCode, string QrUrl, DateTimeOffset StartedAt);
    private readonly ConcurrentDictionary<string, ActiveLogin> logins = new(StringComparer.Ordinal);
    private bool Fresh(ActiveLogin login) => now() - login.StartedAt < TimeSpan.FromMinutes(5);

    internal async Task<JsonObject> StartLoginAsync(string? baseUrl = null, string? botType = null, string? routeTag = null, string? sessionKey = null, bool force = false)
    {
        baseUrl = string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl.Trim();
        botType = string.IsNullOrWhiteSpace(botType) ? DefaultBotType : botType.Trim();
        sessionKey = string.IsNullOrWhiteSpace(sessionKey) ? Guid.NewGuid().ToString() : sessionKey.Trim();
        foreach (var (key, login) in logins) if (!Fresh(login)) logins.TryRemove(key, out _);
        if (!force && logins.TryGetValue(sessionKey, out var existing) && Fresh(existing))
            return new JsonObject { ["sessionKey"] = sessionKey, ["qrcodeUrl"] = existing.QrUrl, ["message"] = "二维码已就绪，请使用微信扫描。" };
        var qr = await LoginGetAsync(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=" + Uri.EscapeDataString(botType), routeTag, false);
        var code = SessionWait.Text(qr["qrcode"]) ?? "";
        var url = SessionWait.Text(qr["qrcode_img_content"]) ?? "";
        logins[sessionKey] = new(code, url, now());
        return new JsonObject { ["sessionKey"] = sessionKey, ["qrcodeUrl"] = url, ["message"] = "使用微信扫描二维码后，再执行 /channel weixin wait <sessionKey> 完成登录。" };
    }

    internal async Task<WeixinLoginResult> WaitLoginAsync(string sessionKey, string? baseUrl = null, string? routeTag = null, int timeoutMs = 60000)
    {
        baseUrl = string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl.Trim();
        if (!logins.TryGetValue(sessionKey, out var login)) return new(false, "当前没有进行中的登录，请先执行 /channel weixin login。");
        if (!Fresh(login))
        {
            logins.TryRemove(sessionKey, out _);
            return new(false, "二维码已过期，请重新执行 /channel weixin login。");
        }
        var deadline = now().AddMilliseconds(Math.Max(timeoutMs, 1000));
        while (now() < deadline)
        {
            var status = await LoginGetAsync(baseUrl, "ilink/bot/get_qrcode_status?qrcode=" + Uri.EscapeDataString(login.QrCode), routeTag, true);
            if (SessionWait.Text(status["status"]) == "confirmed" && SessionWait.Text(status["bot_token"]) is { Length: > 0 } token)
            {
                logins.TryRemove(sessionKey, out _);
                return new(true, "微信登录成功。", token, SessionWait.Text(status["ilink_user_id"]), SessionWait.Text(status["baseurl"]) is { Length: > 0 } returned ? returned : baseUrl);
            }
            if (SessionWait.Text(status["status"]) == "expired")
            {
                logins.TryRemove(sessionKey, out _);
                return new(false, "二维码已过期，请重新执行 /channel weixin login。");
            }
            await DelayAsync(1000);
        }
        return new(false, "登录仍未完成，请稍后重试 /channel weixin wait <sessionKey>。");
    }

    private async Task<JsonObject> LoginGetAsync(string baseUrl, string path, string? routeTag, bool poll)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint(baseUrl, path));
        if (!string.IsNullOrWhiteSpace(routeTag)) request.Headers.TryAddWithoutValidation("SKRouteTag", routeTag.Trim());
        if (poll) request.Headers.TryAddWithoutValidation("iLink-App-ClientVersion", "1");
        using var timeout = poll ? new CancellationTokenSource(TimeSpan.FromSeconds(35)) : new CancellationTokenSource();
        try
        {
            using var response = await http.SendAsync(request, timeout.Token);
            var raw = await response.Content.ReadAsStringAsync(timeout.Token);
            if (!response.IsSuccessStatusCode) throw new IOException((poll ? "Failed to poll QR status: " : "Failed to fetch QR code: ") + (int)response.StatusCode + " " + (raw.Length == 0 ? response.ReasonPhrase : raw));
            return JsonNode.Parse(raw) as JsonObject ?? throw new InvalidDataException("Invalid Weixin QR response.");
        }
        catch (OperationCanceledException) when (poll) { return new JsonObject { ["status"] = "wait" }; }
    }
}
