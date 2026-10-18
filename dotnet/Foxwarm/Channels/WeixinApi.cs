// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2; see THIRD_PARTY_NOTICES.md.
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class WeixinApi
{
    internal const string DefaultBaseUrl = "https://ilinkai.weixin.qq.com";
    internal const string DefaultBotType = "3";
    private static readonly HttpClient DefaultHttp = new() { Timeout = Timeout.InfiniteTimeSpan };
    private static readonly JsonSerializerOptions WireJson = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly HttpClient http;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly Func<DateTimeOffset> now;
    // Source module lifetime: shared per user across all instances and managed reloads, never persisted.
    private readonly ConcurrentDictionary<string, string> contextTokens = new(StringComparer.Ordinal);

    internal WeixinApi(ChannelTransportDependencies? dependencies)
    {
        http = dependencies?.CreateHttp?.Invoke() ?? DefaultHttp;
        delay = dependencies?.Delay ?? Task.Delay;
        now = dependencies?.Now ?? (() => DateTimeOffset.UtcNow);
    }

    internal void CacheContext(string user, string token) => contextTokens[user] = token;
    internal string? Context(string user) => contextTokens.GetValueOrDefault(user);
    internal Task DelayAsync(int milliseconds) => delay(TimeSpan.FromMilliseconds(milliseconds), CancellationToken.None);
    private static Uri Endpoint(string baseUrl, string path) => new(new Uri(baseUrl.TrimEnd('/') + "/"), path);

    private async Task<string> PostAsync(string baseUrl, string? token, string? routeTag, string endpoint, JsonObject body, int timeoutMs, string label)
    {
        body["base_info"] = new JsonObject { ["channel_version"] = ProductVersion.Value };
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString(WireJson));
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint(baseUrl, endpoint));
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Content.Headers.ContentLength = bytes.Length;
        request.Headers.TryAddWithoutValidation("AuthorizationType", "ilink_bot_token");
        var random = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(RandomNumberGenerator.GetBytes(4));
        request.Headers.TryAddWithoutValidation("X-WECHAT-UIN", Convert.ToBase64String(Encoding.UTF8.GetBytes(random.ToString(System.Globalization.CultureInfo.InvariantCulture))));
        if (!string.IsNullOrWhiteSpace(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        if (!string.IsNullOrWhiteSpace(routeTag)) request.Headers.TryAddWithoutValidation("SKRouteTag", routeTag.Trim());
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(Math.Max(0, timeoutMs)));
        using var response = await http.SendAsync(request, timeout.Token);
        var raw = await response.Content.ReadAsStringAsync(timeout.Token);
        if (!response.IsSuccessStatusCode) throw new IOException(label + " " + (int)response.StatusCode + ": " + (raw.Length == 0 ? response.ReasonPhrase : raw));
        return raw;
    }

    internal async Task<JsonObject> UpdatesAsync(string baseUrl, string? token, string? routeTag, string cursor, int timeoutMs = 35000)
    {
        try
        {
            return JsonNode.Parse(await PostAsync(baseUrl, token, routeTag, "ilink/bot/getupdates", new JsonObject { ["get_updates_buf"] = cursor }, timeoutMs, "getUpdates")) as JsonObject
                ?? throw new InvalidDataException("Invalid Weixin getUpdates response.");
        }
        catch (OperationCanceledException) { return new JsonObject { ["ret"] = 0, ["msgs"] = new JsonArray(), ["get_updates_buf"] = cursor }; }
    }

    internal async Task SendAsync(string baseUrl, string? token, string? routeTag, string user, string text)
    {
        var context = Context(user) ?? throw new InvalidOperationException($"No Weixin context token cached for {user}; cannot reply yet.");
        var msg = new JsonObject { ["from_user_id"] = "", ["to_user_id"] = user,
            ["client_id"] = "foxwarm-weixin-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)),
            ["message_type"] = 2, ["message_state"] = 2, ["context_token"] = context };
        if (text.Length > 0) msg["item_list"] = new JsonArray(new JsonObject { ["type"] = 1, ["text_item"] = new JsonObject { ["text"] = text } });
        // Source only checks HTTP status, not a response ret/errcode or JSON payload.
        await PostAsync(baseUrl, token, routeTag, "ilink/bot/sendmessage", new JsonObject { ["msg"] = msg }, 15000, "sendMessage");
    }

    internal async Task SendTypingAsync(string baseUrl, string? token, string? routeTag, string user, string ticket) =>
        await PostAsync(baseUrl, token, routeTag, "ilink/bot/sendtyping", new JsonObject { ["ilink_user_id"] = user, ["typing_ticket"] = ticket, ["status"] = 1 }, 10000, "sendTyping");
}
