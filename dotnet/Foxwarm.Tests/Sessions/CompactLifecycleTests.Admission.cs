using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CompactLifecycleTests
{
    [Fact]
    public async Task Awaited_compact_HTTP_admission_requires_foreground_settlement_after_busy_release()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        var plannerReached = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var plannerClosed = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await using var peer = new ScriptedResponsesSequenceServer(
            10,
            async (index, stream, request) =>
            {
                if (index == 8)
                {
                    Assert.Contains("COMPACTION STARTED:", request.Body);
                    Assert.Contains("seed-stop", request.Body);
                    await stream.WriteAsync(
                        Encoding.UTF8.GetBytes(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                                + "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n"
                        )
                    );
                    await stream.FlushAsync();
                    plannerReached.TrySetResult();
                    Assert.Equal(
                        0,
                        await stream
                            .ReadAsync(new byte[1])
                            .AsTask()
                            .WaitAsync(TimeSpan.FromSeconds(10))
                    );
                    plannerClosed.TrySetResult();
                    return;
                }
                Assert.DoesNotContain("COMPACTION STARTED:", request.Body);
                if (index == 9)
                    Assert.Contains("queued-stop", request.Body);
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["type"] = "output_text",
                                        ["text"] =
                                            index == 9
                                                ? "queued input resumed"
                                                : "synthetic response",
                                    }
                                ),
                            }
                        ),
                        ["usage"] = new JsonObject
                        {
                            ["input_tokens"] = 100,
                            ["output_tokens"] = 12,
                        },
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            $$"""
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                asyncCompact: false
                baseUrl: {{peer.BaseUri}}
                contextLimit: 18000
                models: [wire]
            """
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var created = await client.PostAsJsonAsync("api/sessions", new { });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonObject>())![
            "sessionId"
        ]!.GetValue<string>();
        var manager = (SessionManager)
            typeof(MainHost)
                .GetField("sessions", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(host)!;
        var owner = manager.Find(id)!;
        var route = "api/sessions/" + Uri.EscapeDataString(id);
        var finalizing = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var originalFinalizing = owner.Registry.OnProcessorFinalizing!;
        try
        {
            for (var index = 0; index < 8; index++)
            {
                if (index == 7)
                    owner.Registry.OnProcessorFinalizing = async (
                        entry,
                        error,
                        interrupted,
                        suspended
                    ) =>
                    {
                        await originalFinalizing(entry, error, interrupted, suspended);
                        finalizing.TrySetResult();
                        await release.Task;
                    };
                var response = await client.PostAsJsonAsync(
                    route + "/message",
                    new
                    {
                        text = $"seed-stop-{index} "
                            + string.Concat(Enumerable.Repeat($"stop-{index}-", 170)),
                    }
                );
                Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
                if (index < 7)
                    await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
            }
            await finalizing.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var state = (await client.GetFromJsonAsync<JsonObject>(route + "/state"))!["session"]!;
            Assert.False(state["busy"]!.GetValue<bool>());
            Assert.True(state["runtimeState"]!["processing"]!.GetValue<bool>());
            Assert.NotEmpty(
                CompactCandidateBuilder.Build(owner.Entry.Snapshot().History.Materialize()).Items
            );

            // The legacy command receipt acknowledges the reply, even when the processor is still owned.
            var legacy = await client.PostAsJsonAsync(
                route + "/message",
                new { text = "/compact" }
            );
            Assert.Equal(HttpStatusCode.OK, legacy.StatusCode);
            Assert.True(
                (await legacy.Content.ReadFromJsonAsync<JsonObject>())!["success"]!.GetValue<bool>()
            );
            var refused = await client.PostAsJsonAsync(
                route + "/message",
                new { text = "/compact", controlRequestId = "compact-before-settlement" }
            );
            Assert.Equal(HttpStatusCode.OK, refused.StatusCode);
            Assert.False(
                (await refused.Content.ReadFromJsonAsync<JsonObject>())![
                    "accepted"
                ]!.GetValue<bool>()
            );
            Assert.False(owner.Compactor.Active);
            Assert.Equal(8, peer.RequestCount);
        }
        finally
        {
            owner.Registry.OnProcessorFinalizing = originalFinalizing;
            release.TrySetResult();
            await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        var idle = (await client.GetFromJsonAsync<JsonObject>(route + "/state"))!["session"]!;
        Assert.False(idle["busy"]!.GetValue<bool>());
        Assert.Null(idle["runtimeState"]!["processing"]);
        var accepted = await client.PostAsJsonAsync(
            route + "/message",
            new { text = "/compact", controlRequestId = "compact-after-settlement" }
        );
        Assert.Equal(HttpStatusCode.Accepted, accepted.StatusCode);
        Assert.True(
            (await accepted.Content.ReadFromJsonAsync<JsonObject>())!["accepted"]!.GetValue<bool>()
        );
        try
        {
            await plannerReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var queued = await client.PostAsJsonAsync(
                route + "/message",
                new { text = "queued-stop" }
            );
            Assert.Equal(HttpStatusCode.Accepted, queued.StatusCode);
            Assert.Equal(1, owner.Metadata().QueueLength);
            var stopped = await client.PostAsJsonAsync(
                route + "/message",
                new { text = "/stop compact" }
            );
            Assert.Equal(HttpStatusCode.OK, stopped.StatusCode);
            await plannerClosed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(5));
            await owner.DrainForegroundAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(10, peer.RequestCount);
            var history = owner.Entry.Snapshot().History.Materialize();
            Assert.Contains(
                history,
                row => row.ToJsonString().Contains("queued input resumed", StringComparison.Ordinal)
            );
            Assert.DoesNotContain(history, row => row["__meta"]?["contextBlock"] is not null);
            Assert.Equal(0, owner.Metadata().QueueLength);
        }
        finally
        {
            await owner.Compactor.StopAsync();
        }
    }
}
