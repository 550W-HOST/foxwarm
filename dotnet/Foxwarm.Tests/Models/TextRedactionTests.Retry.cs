using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    [Fact]
    public async Task Detection_and_provider_failures_consume_the_same_six_attempts()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        var failed = false;
        detector.Intercept = async (context, _) =>
        {
            if (failed)
                return false;
            failed = true;
            context.Response.StatusCode = 503;
            await context.Response.WriteAsync("unavailable");
            return true;
        };
        await using var peer = new ScriptedResponsesSequenceServer(
            5,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    503,
                    "application/json",
                    Encoding.UTF8.GetBytes("{}")
                )
        );
        using var http = ProviderHttpRequest.CreateClient();
        var catalog = Catalog(detector.Endpoint, peer.BaseUri);
        using var keys = new TextRedactionKeys();
        var owner = new ModelRequestOwner(
            http,
            new(peer.BaseUri, "m", "p/m", "", "", 100, new()),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: keys.Secrets
        );
        var notices = new List<ModelRetryEvent>();
        var sent = 0;
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            owner.RequestAsync(
                "s",
                catalog,
                "p/m",
                null,
                "cache",
                "turn",
                [ChatResult.Text("input").AssistantMessage!],
                (_, _) => Task.FromResult(""),
                value =>
                {
                    notices.Add(value);
                    return Task.FromResult(false);
                },
                () => sent++,
                null,
                null,
                default
            )
        );
        Assert.Equal(6, error.Final.Attempt);
        Assert.Equal(5, sent);
        Assert.Equal(2, detector.Texts.Count);
        Assert.Equal("text-redaction", notices[0].Kind);
        Assert.All(notices.Skip(1), value => Assert.Equal("http-error", value.Kind));
    }

    [Fact]
    public async Task One_attempt_deadline_includes_detection_and_never_dispatches_the_provider()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, _) =>
        {
            try
            {
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            catch (OperationCanceledException) { }
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        var provider = new Uri("http://127.0.0.1:1");
        var catalog = Catalog(detector.Endpoint, provider);
        using var keys = new TextRedactionKeys();
        var owner = new ModelRequestOwner(
            http,
            new(provider, "m", "p/m", "", "", 100) { HardTimeoutMs = 200 },
            new(),
            (_, _) => throw new Exception("Unexpected extra retry"),
            secrets: keys.Secrets
        );
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            owner.RequestAsync(
                "s",
                owner.Capture(catalog, "p/m", null),
                "cache",
                "turn",
                [ChatResult.Text("input").AssistantMessage!],
                (_, _) => Task.FromResult(""),
                null,
                () => throw new Exception("Unexpected provider send"),
                null,
                null,
                default,
                maxAttempts: 1
            )
        );
        Assert.Equal("text-redaction", error.Final.Kind);
        Assert.Equal(1, error.Final.Attempt);
        Assert.Single(detector.Texts);
    }
}
