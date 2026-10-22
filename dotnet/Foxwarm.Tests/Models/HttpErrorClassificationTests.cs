using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HttpErrorClassificationTests
{
    [Theory]
    [InlineData("openai-responses")]
    [InlineData("anthropic")]
    public async Task Caller_stop_cancels_error_body_collection_after_the_diagnostic_bound(string protocol)
    {
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new LoopbackResponsesServer(async (stream, _) =>
        {
            await stream.WriteAsync(Encoding.ASCII.GetBytes(
                "HTTP/1.1 400 Error\r\nContent-Type: application/json\r\nContent-Length: 70000\r\nConnection: close\r\n\r\n"
            ));
            await stream.WriteAsync(new byte[65536]);
            await stream.FlushAsync();
            sent.TrySetResult();
            await release.Task;
        });
        using var http = ProviderHttpRequest.CreateClient();
        using var stop = new CancellationTokenSource();
        var catalog = HostModels.Parse(new JsonObject
        {
            ["default"] = "a/wire",
            ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject
                {
                    ["providerType"] = protocol,
                    ["baseUrl"] = peer.BaseUri.ToString(),
                    ["models"] = new JsonArray("wire"),
                },
            },
        }, new JsonObject());
        var model = catalog.Resolve("a/wire");
        var options = ConfiguredModelRequests.Plan(
            model, new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 713),
            "low", "prompt", "cache", "turn"
        );
        var service = ConfiguredModelRequests.CreateService(http, model, options, "cache");
        var request = service.ChatAsync("s", [], stop.Token);
        try
        {
            await sent.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(request.IsCompleted);
            stop.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(1, peer.RequestCount);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Theory]
    [InlineData("openai-responses")]
    [InlineData("openai-completions")]
    [InlineData("anthropic")]
    public async Task Complete_error_body_controls_failover_without_expanding_diagnostics(string protocol)
    {
        using var temp = new TempDirectory();
        var errorBody = new JsonObject
        {
            ["error"] = new JsonObject
            {
                ["message"] = new string('x', 70000),
                ["code"] = "model_not_found",
            },
        }.ToJsonString();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            (index, stream, _) => LoopbackResponsesServer.WriteResponseAsync(
                stream,
                index == 0 ? 400 : 200,
                index == 0 ? "application/json" : "text/event-stream",
                Encoding.UTF8.GetBytes(index == 0 ? errorBody :
                    "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"fallback accepted\"}]}]}}\n\n")
            )
        );
        var first = new JsonObject
        {
            ["providerType"] = protocol,
            ["baseUrl"] = peer.BaseUri.ToString(),
            ["models"] = new JsonArray("wire"),
        };
        if (protocol == "anthropic")
            first["extraFields"] = new JsonObject { ["stream"] = false };
        var catalog = HostModels.Parse(new JsonObject
        {
            ["default"] = "route",
            ["providers"] = new JsonObject
            {
                ["a"] = first,
                ["b"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = peer.BaseUri.ToString(),
                    ["models"] = new JsonArray("wire"),
                },
                ["route"] = new JsonObject
                {
                    ["providerType"] = "failover",
                    ["targets"] = new JsonArray("a/wire", "b/wire"),
                    ["failureThreshold"] = 1,
                },
            },
        }, new JsonObject());
        using var http = ProviderHttpRequest.CreateClient();
        var retries = new List<ModelRetryEvent>();
        var owner = new ModelRequestOwner(
            http,
            new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 713),
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            diagnostics: new ModelInteractionDiagnostics(temp.Path)
        );
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var result = await owner.RequestAsync(
            "s", catalog, "route", null, "cache", "turn", [],
            (_, _) => Task.FromResult("prompt"),
            retry => { retries.Add(retry); return Task.FromResult(false); },
            null, null, null, deadline.Token
        );
        Assert.Contains("fallback accepted", result.AssistantMessage!.ToJsonString());
        Assert.Equal("b/wire", result.AssistantMessage["__meta"]!["modelId"]!.GetValue<string>());
        Assert.Equal(2, peer.RequestCount);
        var retry = Assert.Single(retries);
        Assert.False(retry.Final);
        Assert.Equal("400", retry.Status);
        Assert.True(retry.Reason.Length <= 241);
        var response = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(
            Directory.GetFiles(Path.Combine(temp.Path, "state", "logs"), "*_res.json", SearchOption.AllDirectories)
        )))!;
        var failed = Assert.Single(response["attempts"]!.AsArray())!;
        Assert.DoesNotContain("model_not_found", failed["body"]!.ToJsonString());
        Assert.True(Encoding.UTF8.GetByteCount(failed["body"]!.GetValue<string>()) <= 65536);
    }
}
