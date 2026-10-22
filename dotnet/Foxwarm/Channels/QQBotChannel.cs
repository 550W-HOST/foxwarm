using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class QQBotApiException(string message, long? code, int? status = null)
    : IOException(message)
{
    internal long? Code { get; } = code;
    internal int? Status { get; } = status;
}

internal sealed partial class QQBotChannel : IManagedChannel
{
    private const string ApiBase = "https://api.sgroup.qq.com";
    private const string TokenUrl = "https://bots.qq.com/app/getAppAccessToken";
    private readonly string id;
    private readonly JsonObject config;
    private readonly SessionManager sessions;
    private readonly MessageRouter router;
    private readonly HttpClient http;
    private readonly Action<Exception> log;
    private readonly Func<DateTimeOffset> now;
    private readonly Func<TimeSpan, CancellationToken, Task> delay;
    private readonly TimeSpan? partTimeout;
    private readonly object stateGate = new();
    private readonly object tokenGate = new();
    private string? accessToken;
    private DateTimeOffset tokenExpires;
    private Task<string>? tokenRequest;
    private volatile bool stopped = true;
    private long generation;
    private CancellationTokenSource lifetime = new();
    private Task? gatewayTask;
    private static uint outboundSequence = Math.Max(
        1u,
        BitConverter.ToUInt32(RandomNumberGenerator.GetBytes(4))
    );
    private static readonly object sequenceGate = new();

    internal QQBotChannel(
        string id,
        JsonObject config,
        SessionManager sessions,
        MessageRouter router,
        ChannelTransportDependencies? dependencies,
        Action<Exception> log
    )
    {
        this.id = id;
        this.config = (JsonObject)config.DeepClone();
        this.sessions = sessions;
        this.router = router;
        this.log = log;
        partTimeout = dependencies?.QQBotPartTimeout;
        now = dependencies?.Now ?? (() => DateTimeOffset.UtcNow);
        delay = dependencies?.Delay ?? Task.Delay;
        http =
            dependencies?.CreateQQBotHttp?.Invoke()
            ?? new HttpClient(
                new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }
            );
        groupLimit = GroupOption("groupContextLimit", 10, 0, 50);
        batchWindow = GroupOption("groupBatchWindowMs", 5000, 250, 30000, true);
        media = new QQBotMedia(sessions, http, config["media"] as JsonObject, dependencies);
        Transport = new("qqbot", SendAsync, SendFileAsync, TypingAsync);
    }

    internal RegisteredChannel Transport { get; }
    RegisteredChannel IManagedChannel.Transport => Transport;

    private static string? Text(JsonNode? value) => SessionWait.Text(value);

    private static string Required(JsonNode? value, string label) =>
        Text(value)?.Trim() is { Length: > 0 } text
            ? text
            : throw new InvalidDataException("QQ Bot " + label + " is required.");

    internal static (string Kind, string Id) Parse(string value)
    {
        var colon = value.IndexOf(':');
        if (
            colon <= 0
            || value[(colon + 1)..].Trim() is not { Length: > 0 } target
            || value[..colon] is not ("c2c" or "group" or "guild" or "dm")
        )
            throw new InvalidDataException(
                "QQ Bot conversationId must be c2c:<openid>, group:<group-openid>, guild:<channel-id>, or dm:<guild-id>."
            );
        return (value[..colon], target);
    }

    internal static uint AllocateSequence()
    {
        lock (sequenceGate)
        {
            var result = outboundSequence;
            outboundSequence = result == uint.MaxValue ? 1 : result + 1;
            return result;
        }
    }

    private bool Current(long expected) => !stopped && Interlocked.Read(ref generation) == expected;

    private void RequireCurrent(long expected)
    {
        if (!Current(expected))
            throw new IOException("QQ Bot operation was invalidated before delivery.");
    }

    private async Task ObserveAsync(Task operation)
    {
        try
        {
            await operation;
        }
        catch (OperationCanceledException) when (stopped) { }
        catch (Exception error)
        {
            log(error);
        }
    }

    private Task<string> GetTokenAsync()
    {
        lock (tokenGate)
        {
            if (accessToken is not null && tokenExpires - now() > TimeSpan.FromMinutes(1))
                return Task.FromResult(accessToken);
            return tokenRequest ??= FetchTokenAsync();
        }
    }

    private async Task<string> FetchTokenAsync()
    {
        // Defer execution until the coalesced task has been published under tokenGate.
        await Task.Yield();
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, TokenUrl)
            {
                Content = JsonContent(
                    new JsonObject
                    {
                        ["appId"] = Required(config["appId"], "appId"),
                        ["clientSecret"] = Required(config["clientSecret"], "clientSecret"),
                    }
                ),
            };
            using var response = await http.SendAsync(request, lifetime.Token);
            var text = await response.Content.ReadAsStringAsync(lifetime.Token);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException(
                    "QQ Bot token request failed.",
                    null,
                    response.StatusCode
                );
            var payload =
                JsonNode.Parse(text)?.AsObject()
                ?? throw new IOException("QQ Bot access token response was not JSON.");
            var token = Required(payload["access_token"], "access_token");
            var expires = Number(payload["expires_in"]);
            lock (tokenGate)
            {
                accessToken = token;
                tokenExpires = now().AddSeconds(expires is > 0 and < 1e10 ? expires.Value : 7200);
            }
            return token;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new ChannelFailure("token acquisition", error);
        }
        finally
        {
            lock (tokenGate)
                tokenRequest = null;
        }
    }

    private static double? Number(JsonNode? value) =>
        double.TryParse(
            value?.ToString(),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out var result
        ) && double.IsFinite(result)
            ? result
            : null;

    private static double? Numeric(JsonNode? value) =>
        value?.GetValueKind() == System.Text.Json.JsonValueKind.Number ? Number(value) : null;

    private static StringContent JsonContent(JsonObject body) =>
        new(body.ToJsonString(), Encoding.UTF8, "application/json");

    private async Task<JsonObject> ApiAsync(
        string path,
        JsonObject? body = null,
        CancellationToken token = default,
        int? maxBytes = null,
        long? expected = null
    )
    {
        for (var attempt = 0; ; attempt++)
        {
            if (expected is { } initialFence)
                RequireCurrent(initialFence);
            var credential = await GetTokenAsync();
            if (expected is { } fence)
                RequireCurrent(fence);
            using var request = new HttpRequestMessage(
                body is null ? HttpMethod.Get : HttpMethod.Post,
                ApiBase + path
            );
            request.Headers.Authorization = new AuthenticationHeaderValue("QQBot", credential);
            if (body is not null)
                request.Content = JsonContent(body);
            using var response = await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                token
            );
            if (response.StatusCode == HttpStatusCode.Unauthorized && attempt == 0)
            {
                lock (tokenGate)
                    if (accessToken == credential)
                        accessToken = null;
                continue;
            }
            var text = maxBytes is { } bound
                ? await ReadBoundedAsync(response, bound, token)
                : await response.Content.ReadAsStringAsync(token);
            if (!response.IsSuccessStatusCode)
            {
                long? code = null;
                try
                {
                    var parsed = JsonNode.Parse(text);
                    foreach (var candidate in new[] { parsed?["code"], parsed?["err_code"] })
                        if (long.TryParse(candidate?.ToString(), out var c))
                        {
                            code = c;
                            break;
                        }
                }
                catch (System.Text.Json.JsonException) { }
                throw new QQBotApiException(
                    $"QQ Bot API request failed ({(int)response.StatusCode}).",
                    code,
                    (int)response.StatusCode
                );
            }
            if (string.IsNullOrWhiteSpace(text))
                return new();
            try
            {
                return JsonNode.Parse(text)?.AsObject()
                    ?? throw new IOException("QQ Bot API returned invalid JSON.");
            }
            catch (System.Text.Json.JsonException)
            {
                throw new IOException("QQ Bot API returned invalid JSON.");
            }
        }
    }

    internal static async Task<string> ReadBoundedAsync(
        HttpResponseMessage response,
        int limit,
        CancellationToken token
    )
    {
        if (response.Content.Headers.ContentLength > limit)
            throw new IOException(
                "QQ Bot API response exceeded the bounded media-upload response limit."
            );
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var result = new MemoryStream();
        var buffer = new byte[65536];
        int count;
        while ((count = await stream.ReadAsync(buffer, token)) != 0)
        {
            if (result.Length + count > limit)
                throw new IOException(
                    "QQ Bot API response exceeded the bounded media-upload response limit."
                );
            result.Write(buffer, 0, count);
        }
        return Encoding.UTF8.GetString(result.ToArray());
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        http.Dispose();
    }
}
