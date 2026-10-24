using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class ChannelHttpPolicyTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private sealed record Response(Func<HttpContext, Task> Write) : IResult
    {
        public Task ExecuteAsync(HttpContext context) => Write(context);
    }

    private static IResult Held(
        bool body,
        TaskCompletionSource entered,
        TaskCompletionSource aborted
    ) =>
        new Response(async context =>
        {
            try
            {
                if (body)
                {
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync("{", context.RequestAborted);
                    await context.Response.Body.FlushAsync(context.RequestAborted);
                }
                entered.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                aborted.TrySetResult();
            }
        });

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Telegram_header_and_body_deadlines_retry_but_caller_cancellation_does_not(
        bool body
    )
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync();
        var entered = Signal();
        var aborted = Signal();
        var attempts = 0;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "sendMessage" && Interlocked.Increment(ref attempts) == 1
                    ? Held(body, entered, aborted)
                    : null
            );
        var errors = new ConcurrentQueue<Exception>();
        await using var channel = new TelegramChannel(
            "alpha",
            ExternalChannelFixture.Channel(),
            f.Manager,
            f.Router,
            peer.Dependencies with
            {
                TelegramApiTimeout = TimeSpan.FromMilliseconds(250),
            },
            errors.Enqueue
        );
        await channel.SendAsync("42", "retry deadline", default).WaitAsync(TimeSpan.FromSeconds(5));
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, attempts);
        Assert.IsType<HttpRequestException>(Assert.Single(errors));
        Assert.Equal(new[] { TimeSpan.FromSeconds(5) }, peer.Delays.ToArray());

        entered = Signal();
        aborted = Signal();
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "sendMessage" ? Held(body, entered, aborted) : null
            );
        using var caller = new CancellationTokenSource();
        var send = channel.SendAsync("42", "cancel caller", caller.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send);
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(3, peer.Sent("a").Count());
        Assert.Single(errors);
        Assert.Single(peer.Delays);
    }

    [Fact]
    public async Task Telegram_body_gets_a_fresh_budget_after_headers_and_upload_retries_reopen_the_file()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync();
        var attempts = 0;
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method != "sendDocument"
                    ? null
                    : new Response(async context =>
                    {
                        if (Interlocked.Increment(ref attempts) == 1)
                        {
                            // Combined duration exceeds the scaled API budget; each phase fits.
                            await Task.Delay(350, context.RequestAborted);
                            context.Response.ContentType = "application/json";
                            await context.Response.WriteAsync(
                                "{\"ok\":true,\"result\":",
                                context.RequestAborted
                            );
                            await context.Response.Body.FlushAsync(context.RequestAborted);
                            await Task.Delay(350, context.RequestAborted);
                            await context.Response.WriteAsync("true}", context.RequestAborted);
                        }
                        else
                            await Results
                                .Json(new { ok = true, result = true })
                                .ExecuteAsync(context);
                    })
            );
        await using var channel = new TelegramChannel(
            "alpha",
            ExternalChannelFixture.Channel(),
            f.Manager,
            f.Router,
            peer.Dependencies with
            {
                TelegramApiTimeout = TimeSpan.FromMilliseconds(600),
            },
            _ => { }
        );
        var path = Path.Combine(f.Work, "upload.txt");
        await File.WriteAllTextAsync(path, "upload bytes");
        var file = new ChannelFile(path, "upload.txt", "text/plain", false);
        await channel.SendFileAsync("42", file, null, default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, attempts);
        Assert.Empty(peer.Delays);

        var entered = Signal();
        var aborted = Signal();
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Method == "sendDocument" && Interlocked.Increment(ref attempts) == 2
                    ? Held(true, entered, aborted)
                    : null
            );
        await channel.SendFileAsync("42", file, null, default).WaitAsync(TimeSpan.FromSeconds(5));
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(3, peer.Sent("a", "sendDocument").Count());
        Assert.All(
            peer.Sent("a", "sendDocument"),
            call => Assert.Equal("upload bytes"u8.ToArray(), call.Bytes)
        );
        Assert.Single(peer.Delays);
    }

    [Fact]
    public async Task Telegram_download_has_no_api_or_client_deadline_and_stop_still_aborts_it()
    {
        await using var peer = await TelegramPeer.StartAsync();
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
        var entered = Signal();
        var aborted = Signal();
        peer.FileResponse = path =>
            path == "slow"
                ? new Response(async context =>
                {
                    await Task.Delay(400, context.RequestAborted);
                    await context.Response.WriteAsync("download bytes", context.RequestAborted);
                })
                : Held(true, entered, aborted);
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies with
            {
                CreateHttp = () => http,
                TelegramApiTimeout = TimeSpan.FromMilliseconds(250),
            }
        );
        f.Manager.AttachChannel("alpha:42", f.Owner);
        await f.Manager.ManagedChannels!.ReloadAsync();
        Assert.Equal(Timeout.InfiniteTimeSpan, http.Timeout);
        JsonObject Document(string path)
        {
            var message = TelegramPeer.Text("42", "11", "unused");
            message.Remove("text");
            message["document"] = new JsonObject
            {
                ["file_id"] = path,
                ["file_name"] = "document.txt",
            };
            return message;
        }
        peer.Push("a", Document("slow"));
        await TelegramChannelTests.Until(() => f.Owner.Entry.Snapshot().Queue.Count == 1);
        var saved = Assert.Single(
            Directory.GetFiles(
                Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "telegram")
            )
        );
        Assert.Equal("download bytes", await File.ReadAllTextAsync(saved));
        peer.Push("a", Document("cancel"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.ManagedChannels.ChangeAsync("stop", "alpha");
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task QQ_token_and_api_ignore_the_client_default_and_keep_caller_cancellation(
        bool body
    )
    {
        await using var peer = await QQBotPeer.StartAsync();
        var http = peer.Dependencies.CreateQQBotHttp!();
        http.Timeout = TimeSpan.FromMilliseconds(50);
        var entered = Signal();
        var aborted = Signal();
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path == "/app/getAppAccessToken"
                    ? new Response(async context =>
                    {
                        await Task.Delay(100, context.RequestAborted);
                        context.Response.ContentType = "application/json";
                        await context.Response.WriteAsync(
                            "{\"access_token\":",
                            context.RequestAborted
                        );
                        await context.Response.Body.FlushAsync(context.RequestAborted);
                        await Task.Delay(100, context.RequestAborted);
                        await context.Response.WriteAsync(
                            "\"fixture-token\",\"expires_in\":7200}",
                            context.RequestAborted
                        );
                    })
                : call.Path.EndsWith("/messages") ? Held(body, entered, aborted)
                : null
            );
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies with
            {
                CreateQQBotHttp = () => http,
            }
        );
        await QQBotChannelTests.Start(f, peer);
        Assert.Equal(Timeout.InfiniteTimeSpan, http.Timeout);
        using var caller = new CancellationTokenSource();
        var send = f
            .Manager.ChannelRegistry.Get("qq")!
            .Send("c2c:alice", "cancel caller", new(), caller.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(100);
        Assert.False(send.IsCompleted);
        caller.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send);
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single(peer.Sent);
    }

    [Fact]
    public async Task QQ_stop_cancels_token_body_consumption_without_publishing_a_gateway()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync();
        var entered = Signal();
        var aborted = Signal();
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path == "/app/getAppAccessToken" ? Held(true, entered, aborted) : null
            );
        await using var channel = new QQBotChannel(
            "qq",
            peer.Config(),
            f.Manager,
            f.Router,
            peer.Dependencies,
            _ => { }
        );
        var start = channel.StartAsync();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await channel.StopAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            start.WaitAsync(TimeSpan.FromSeconds(5))
        );
        await aborted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.DoesNotContain(peer.Calls, call => call.Path == "/gateway");
    }
}
