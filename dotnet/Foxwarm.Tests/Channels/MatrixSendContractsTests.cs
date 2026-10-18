using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class MatrixSendContractsTests
{
    private const string EncryptionError =
        "This room is configured to use encryption, but your client does not support encryption.";

    [Theory]
    [InlineData("state")]
    [InlineData("org.matrix.msc4222.state_after")]
    [InlineData("timeline")]
    [InlineData("invite_state")]
    public async Task Real_sync_encryption_state_refuses_shared_text_and_file_sends_without_restricting_unknown_rooms(string section)
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = peer.Matrix() }, dependencies: peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Calls.Count(call => call.Path.EndsWith("/sync")) >= 2);
        var transport = f.Manager.ChannelRegistry.Get("alpha")!;
        await transport.Send("!unknown:fixture", "unknown is allowed", new(), default);
        await transport.Send("!room:fixture", "not yet encrypted", new(), default);
        var syncCount = peer.Calls.Count(call => call.Path.EndsWith("/sync"));
        peer.Push("matrix-a", new JsonObject
        {
            ["next_batch"] = "encryption",
            ["rooms"] = new JsonObject
            {
                [section == "invite_state" ? "invite" : "join"] = new JsonObject
                {
                    ["!room:fixture"] = new JsonObject
                    {
                        [section] = new JsonObject
                        {
                            ["events"] = new JsonArray(new JsonObject
                            {
                                ["type"] = "m.room.encryption", ["state_key"] = "",
                                ["content"] = new JsonObject { ["algorithm"] = "m.megolm.v1.aes-sha2" }
                            })
                        }
                    }
                }
            }
        });
        await TelegramChannelTests.Until(() => peer.Calls.Count(call => call.Path.EndsWith("/sync")) > syncCount);
        var sentBefore = peer.Sent("matrix-a").Length;
        var text = await f.ToolAsync("send_to_channel", new JsonObject
        {
            ["channelTargetId"] = "alpha:!room:fixture", ["message"] = "private text"
        });
        Assert.Contains(EncryptionError, text!.ToJsonString());
        var file = Path.Combine(f.Work, "private.txt");
        await File.WriteAllTextAsync(file, "synthetic file");
        var caption = await f.ToolAsync("send_file", new JsonObject
        {
            ["channelTargetId"] = "alpha:!room:fixture", ["filePath"] = file, ["caption"] = "private caption"
        });
        Assert.Contains(EncryptionError, caption!.ToJsonString());
        Assert.DoesNotContain(peer.Calls, call => call.Path.EndsWith("/upload"));
        var noCaption = await f.ToolAsync("send_file", new JsonObject
        {
            ["channelTargetId"] = "alpha:!room:fixture", ["filePath"] = file
        });
        Assert.Contains(EncryptionError, noCaption!.ToJsonString());
        // Source uploads an uncaptioned file before sendEvent performs its encryption check.
        Assert.Single(peer.Calls, call => call.Path.EndsWith("/upload"));
        Assert.Equal(sentBefore, peer.Sent("matrix-a").Length);
        await transport.Send("!unknown:fixture", "still allowed", new(), default);
        peer.MatrixEvents("matrix-a", "!plain:fixture", ExternalProtocolPeer.MatrixText("plain", "hello"));
        await TelegramChannelTests.Until(() => peer.Calls.Any(call => call.Query.GetValueOrDefault("since")?.StartsWith("cursor-") == true));
        await transport.Send("!plain:fixture", "known unencrypted", new(), default);
    }

    [Theory]
    [InlineData(503, "M_UNAVAILABLE", true, false, 2000)]
    [InlineData(503, "M_LIMIT_EXCEEDED", true, false, 121000)]
    [InlineData(429, "M_UNKNOWN", true, false, 121000)]
    [InlineData(429, null, true, false, 121000)]
    [InlineData(429, "M_UNAVAILABLE", true, false, 2000)]
    [InlineData(503, "M_LIMIT_EXCEEDED", false, true, 7)]
    [InlineData(503, "M_UNAVAILABLE", false, true, 2000)]
    [InlineData(429, "M_UNKNOWN", false, true, 2000)]
    public async Task Retry_recommendations_follow_SDK_rate_limit_classification(int status, string? code, bool header, bool body, int expectedMs)
    {
        var calls = new List<string>();
        var delays = new List<TimeSpan>();
        using var http = new HttpClient(new Handler(async (request, _) =>
        {
            calls.Add(request.RequestUri!.AbsolutePath);
            await request.Content!.ReadAsStringAsync();
            if (calls.Count > 1)
                return Response(200, new JsonObject { ["event_id"] = "$ok" });
            var result = new JsonObject();
            if (code is not null) result["errcode"] = code;
            if (body) result["retry_after_ms"] = 7;
            var response = Response(status, result);
            if (header) response.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(121));
            return response;
        })) { Timeout = Timeout.InfiniteTimeSpan };
        await using var channel = Channel(http, (duration, _) => { delays.Add(duration); return Task.CompletedTask; });
        await channel.Transport.Send("!room:fixture", "retry", new(), default);
        Assert.Equal(TimeSpan.FromMilliseconds(expectedMs), Assert.Single(delays));
        Assert.Equal(2, calls.Count);
        Assert.Single(calls.Distinct());
    }

    [Fact]
    public async Task Four_backoffs_preserve_transaction_and_fail_queued_successors_but_not_later_sends()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var paths = new List<string>();
        var texts = new List<string>();
        var delays = new List<TimeSpan>();
        using var http = new HttpClient(new Handler(async (request, _) =>
        {
            var text = SessionWait.Text(JsonNode.Parse(await request.Content!.ReadAsStringAsync())!["body"])!;
            texts.Add(text);
            paths.Add(request.RequestUri!.AbsolutePath);
            if (text == "later") return Response(200, new JsonObject { ["event_id"] = "$ok" });
            if (texts.Count == 1) { entered.TrySetResult(); await release.Task; }
            return Response(503, new JsonObject { ["errcode"] = "M_UNAVAILABLE" });
        })) { Timeout = Timeout.InfiniteTimeSpan };
        await using var channel = Channel(http, (duration, _) => { delays.Add(duration); return Task.CompletedTask; });
        var first = channel.Transport.Send("!room:fixture", "first", new(), default);
        await entered.Task;
        var queued = channel.Transport.Send("!other:fixture", "queued", new(), default);
        release.TrySetResult();
        await Assert.ThrowsAsync<MatrixApiException>(() => first);
        await Assert.ThrowsAsync<MatrixApiException>(() => queued);
        Assert.Equal(new[] { 2d, 4d, 8d, 16d }, delays.Select(value => value.TotalSeconds));
        Assert.Equal(5, texts.Count);
        Assert.All(texts, text => Assert.Equal("first", text));
        Assert.Single(paths.Distinct());
        await channel.Transport.Send("!other:fixture", "later", new(), default);
        Assert.Equal("later", texts.Last());
    }

    [Fact]
    public async Task Ordinary_requests_remain_cancellable_by_the_actual_caller()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var http = new HttpClient(new Handler(async (_, token) =>
        {
            entered.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, token);
            return Response(200, new JsonObject());
        })) { Timeout = Timeout.InfiniteTimeSpan };
        await using var channel = Channel(http, Task.Delay);
        using var cancellation = new CancellationTokenSource();
        var sending = channel.Transport.Send("!room:fixture", "cancelled", new(), cancellation.Token);
        await entered.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => sending);
    }

    private static MatrixChannel Channel(HttpClient http, Func<TimeSpan, CancellationToken, Task> delay) =>
        new("alpha", new JsonObject { ["homeserver"] = "http://127.0.0.1:1", ["accessToken"] = "synthetic", ["botUserId"] = "@bot:fixture" }, null!, null!, new(CreateHttp: () => http, Delay: delay), _ => { });

    private static HttpResponseMessage Response(int status, JsonObject body) =>
        new((HttpStatusCode)status) { Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request, token);
    }
}
