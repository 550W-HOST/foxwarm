using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ExternalChannelDeliveryContractTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static byte[] Complete(JsonArray output) =>
        Encoding.UTF8.GetBytes(
            "data: "
                + new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject { ["status"] = "completed", ["output"] = output },
                }.ToJsonString()
                + "\n\n"
        );

    [Theory]
    [InlineData("answer")]
    [InlineData("empty")]
    [InlineData("error")]
    public async Task Held_automatic_text_or_terminal_acknowledgement_does_not_own_busy_next_input_stop_or_drain(
        string kind
    )
    {
        await using var provider = new ScriptedResponsesSequenceServer(
            2,
            (index, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    kind == "error" && index == 0 ? 400 : 200,
                    kind == "error" && index == 0 ? "application/json" : "text/event-stream",
                    kind == "error" && index == 0
                        ? Encoding.UTF8.GetBytes(
                            "{\"error\":{\"message\":\"controlled refusal\",\"type\":\"invalid_request_error\"}}"
                        )
                        : Complete(
                            kind == "empty" && index == 0
                                ? new JsonArray()
                                : new JsonArray(TelegramHostTests.Output("answer-" + index))
                        )
                )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var entered = Signal();
        var release = Signal();
        var sent = new ConcurrentQueue<string>();
        var finals = 0;
        f.Manager.ChannelRegistry.Register(
            "controlled",
            new RegisteredChannel(
                "controlled",
                async (_, text, options, _) =>
                {
                    sent.Enqueue(text);
                    if (options.TurnFinal)
                        Interlocked.Increment(ref finals);
                    entered.TrySetResult();
                    await release.Task;
                },
                Finalize: async (_, _, _) =>
                {
                    Interlocked.Increment(ref finals);
                    entered.TrySetResult();
                    await release.Task;
                }
            )
        );
        f.Manager.AttachChannel("controlled:42", f.Owner);
        try
        {
            await new SessionRuntime(f.Manager).SubmitAndRunAsync(
                f.Owner.Id,
                QueueItem.UserText("first")
            );
            var processing = f.Owner.StartProcessing();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await processing.WaitAsync(TimeSpan.FromSeconds(2));
            Assert.False(f.Owner.Metadata().Busy);
            Assert.Equal(1, finals);
            await new SessionRuntime(f.Manager).SubmitAndRunAsync(
                f.Owner.Id,
                QueueItem.UserText("second")
            );
            await f.Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, provider.RequestCount);
            Assert.Contains("answer-1", sent);
            await new SessionRuntime(f.Manager)
                .StopAsync(f.Owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(2));
            await f.Manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(2));
            Assert.False(release.Task.IsCompleted);
            Assert.DoesNotContain(
                sent,
                text => text.Contains("Execution stopped", StringComparison.Ordinal)
            );
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Strict_idle_release_failure_keeps_busy_and_the_committed_answer_without_a_second_channel_final()
    {
        if (OperatingSystem.IsWindows())
            return;
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Complete(new JsonArray(TelegramHostTests.Output("completed-answer")))
                )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var directory = Path.GetDirectoryName(f.Owner.AuthorityStore.AuthorityPath)!;
        var mode = File.GetUnixFileMode(directory);
        var sent = new List<string>();
        f.Manager.ChannelRegistry.Register(
            "controlled",
            new RegisteredChannel(
                "controlled",
                (_, text, _, _) =>
                {
                    sent.Add(text);
                    if (!OperatingSystem.IsWindows() && text == "completed-answer")
                        File.SetUnixFileMode(
                            directory,
                            UnixFileMode.UserRead | UnixFileMode.UserExecute
                        );
                    return Task.CompletedTask;
                }
            )
        );
        f.Manager.AttachChannel("controlled:42", f.Owner);
        try
        {
            await new SessionRuntime(f.Manager).SubmitAndRunAsync(
                f.Owner.Id,
                QueueItem.UserText("finish")
            );
            await f.Owner.StartProcessing();
            Assert.True(f.Owner.Metadata().Busy);
            Assert.Equal(2, f.Owner.History().Count);
            Assert.Equal(new[] { "completed-answer" }, sent);
            Assert.True(f.Owner.Entry.BackgroundProcessorFailureCount > 0);
            var disk = JsonNode.Parse(
                await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath)
            )!;
            Assert.True(SessionCatalog.Flag(disk["busy"]));
        }
        finally
        {
            File.SetUnixFileMode(directory, mode);
            await f.Owner.Registry.HostFor(f.Owner.Id).ReleaseBusyAsync();
        }
    }

    [Theory]
    [InlineData("max_tokens")]
    [InlineData("model_context_window_exceeded")]
    public async Task Real_Anthropic_stop_notice_stays_in_canonical_history_without_an_extra_channel_final(
        string stopReason
    )
    {
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        new JsonObject
                        {
                            ["id"] = "fixture-message",
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["model"] = "wire",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "text", ["text"] = "truncated-answer" }
                            ),
                            ["stop_reason"] = stopReason,
                            ["usage"] = new JsonObject
                            {
                                ["input_tokens"] = 1,
                                ["output_tokens"] = 2,
                            },
                        }.ToJsonString()
                    )
                )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "local/wire",
                ["providers"] = new JsonObject
                {
                    ["local"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = provider.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                    },
                },
            }.ToJsonString()
        );
        var sent = new List<string>();
        var finals = 0;
        f.Manager.ChannelRegistry.Register(
            "controlled",
            new RegisteredChannel(
                "controlled",
                (_, text, options, _) =>
                {
                    sent.Add(text);
                    if (options.TurnFinal)
                        finals++;
                    return Task.CompletedTask;
                }
            )
        );
        f.Manager.AttachChannel("controlled:42", f.Owner);
        await new SessionRuntime(f.Manager).SubmitAndRunAsync(
            f.Owner.Id,
            QueueItem.UserText("truncated")
        );
        await f.Owner.StartProcessing();
        Assert.Equal(new[] { "truncated-answer" }, sent);
        Assert.Equal(1, finals);
        var notice = Assert.Single(
            f.Owner.History(),
            row => SessionWait.Text(row["__meta"]?["noticeType"]) == "llm-stop"
        );
        Assert.False(SessionCatalog.Flag(notice["modelVisible"]));
        Assert.Equal(stopReason, SessionWait.Text(notice["__meta"]?["stopReason"]));
    }

    [Fact]
    public async Task Generated_image_delivery_and_explicit_tool_send_still_await_their_transport_results()
    {
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Complete(
                        new JsonArray(
                            TelegramHostTests.Output("image-answer"),
                            new JsonObject
                            {
                                ["type"] = "image_generation_call",
                                ["id"] = "generated-fixture",
                                ["status"] = "completed",
                                ["output_format"] = "jpeg",
                                ["result"] = Convert.ToBase64String(TelegramChannelTests.Jpeg()),
                            }
                        )
                    )
                )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var entered = Signal();
        var release = Signal();
        f.Manager.ChannelRegistry.Register(
            "controlled",
            new RegisteredChannel(
                "controlled",
                (_, _, _, _) => Task.CompletedTask,
                SendFile: async (_, _, _, _) =>
                {
                    entered.TrySetResult();
                    await release.Task;
                }
            )
        );
        f.Manager.AttachChannel("controlled:42", f.Owner);
        await new SessionRuntime(f.Manager).SubmitAndRunAsync(
            f.Owner.Id,
            QueueItem.UserText("draw")
        );
        var processing = f.Owner.StartProcessing();
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(f.Owner.Metadata().Busy);
            Assert.False(processing.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
            await processing.WaitAsync(TimeSpan.FromSeconds(5));
        }
        entered = Signal();
        release = Signal();
        f.Manager.ChannelRegistry.Register(
            "explicit",
            new RegisteredChannel(
                "controlled",
                async (_, _, _, _) =>
                {
                    entered.TrySetResult();
                    await release.Task;
                    throw new IOException("controlled explicit failure");
                }
            )
        );
        var tool = f.ToolAsync(
            "send_to_channel",
            new JsonObject { ["channelTargetId"] = "explicit:42", ["message"] = "explicit" }
        );
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(tool.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        Assert.NotNull((await tool.WaitAsync(TimeSpan.FromSeconds(5)))!["error"]);
    }
}
