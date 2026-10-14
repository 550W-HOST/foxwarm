using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ResponsesClientTests
{
    [Fact]
    public async Task RealFunctionCallLoopWritesFixtureAndSendsPairedSecondRequestUnderOneProcessor()
    {
        var root = NewTempDirectory();
        try
        {
            var first = CompletedSse(
                new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "call_write",
                        ["name"] = "write_fixture",
                        ["arguments"] = "{\"fileName\":\"result.txt\",\"content\":\"héllo\"}",
                    }
                )
            );
            var second = CompletedSse(
                new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["phase"] = "final_answer",
                        ["content"] = new JsonArray(
                            new JsonObject { ["type"] = "output_text", ["text"] = "done" }
                        ),
                    }
                )
            );
            await using var server = new ScriptedResponsesSequenceServer(
                2,
                (index, stream, _) =>
                    LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(index == 0 ? first : second),
                        1,
                        3,
                        7,
                        13
                    )
            );
            using var http = new HttpClient();
            var executor = new WriteFixtureToolExecutor(root);
            var store = new PersistentSessionAuthorityStore(root, "s");
            var registry = new SessionRegistry(store, NewService(http, server.BaseUri), executor);
            var entry = registry.Add("s");
            entry.State.Queue.Add(QueueItem.UserText("write it"));

            await registry.Runner.ProcessQueueAsync("s");

            var firstRequest =
                JsonNode.Parse((await server.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(5))).Body)
                as JsonObject;
            var secondRequest =
                JsonNode.Parse((await server.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(5))).Body)
                as JsonObject;
            Assert.NotNull(firstRequest);
            Assert.NotNull(secondRequest);
            Assert.Equal(2, server.RequestCount);
            var secondInput = Assert.IsType<JsonArray>(secondRequest!["input"]);
            Assert.Equal(
                new[] { "message", "function_call", "function_call_output" },
                secondInput.Select(item => item!["type"]!.GetValue<string>())
            );
            Assert.Equal("call_write", secondInput[1]?["call_id"]?.GetValue<string>());
            Assert.Equal(
                "{\"fileName\":\"result.txt\",\"content\":\"héllo\"}",
                secondInput[1]?["arguments"]?.GetValue<string>()
            );
            Assert.Equal("call_write", secondInput[2]?["call_id"]?.GetValue<string>());
            var output = Assert.IsType<JsonArray>(secondInput[2]?["output"]);
            Assert.StartsWith(
                "<foxwarm-system kind=\"time\"",
                output[0]?["text"]?.GetValue<string>()
            );
            Assert.Equal("created", output[1]?["text"]?.GetValue<string>());

            var snapshot = entry.Snapshot();
            Assert.Equal(
                new[] { "user", "model", "tool", "model" },
                snapshot.History.Select(message => message["role"]!.GetValue<string>())
            );
            Assert.Equal(
                new long[] { 1, 2, 3, 4 },
                snapshot.History.Select(message => message["__meta"]!["seq"]!.GetValue<long>())
            );
            Assert.Equal(5, snapshot.NextMessageSeq);
            Assert.Equal(1, entry.ProcessorClaimCount);
            Assert.Equal(1, executor.SuccessfulEffects);
            Assert.Equal(
                Encoding.UTF8.GetBytes("héllo"),
                await File.ReadAllBytesAsync(Path.Combine(root, "result.txt"))
            );
            var stored = await store.LoadAsync("s");
            Assert.Equal(
                snapshot.History.Select(message => message.ToJsonString()),
                stored!.History.Select(message => message.ToJsonString())
            );
            var archive = store.Archive.ReadMessages();
            Assert.Equal(4, archive.Count);
            Assert.Equal(
                snapshot.History.Select(EcmaJson.Stringify),
                archive.Select(record => record.MessageJson)
            );
            var replayResult = Path.Combine(root, "actual-ts-replay.json");
            RunPersistenceOracle("replay-ts", root, replayResult, "s");
            Assert.Equal(
                0,
                JsonNode.Parse(await File.ReadAllTextAsync(replayResult))![
                    "insertedCount"
                ]!.GetValue<int>()
            );
            var readResult = Path.Combine(root, "actual-ts-read.json");
            RunPersistenceOracle("read", root, readResult, "s");
            var actual = JsonNode.Parse(await File.ReadAllTextAsync(readResult))!.AsObject();
            Assert.Equal(4, actual["rawRows"]!.AsArray().Count);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task LocalHttpSseRoundTripPersistsOwnedCanonicalAssistantOnce()
    {
        var response = new JsonObject
        {
            ["id"] = "response-1",
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "reasoning",
                    ["summary"] = new JsonArray(
                        new JsonObject { ["type"] = "summary_text", ["text"] = "considered" }
                    ),
                    ["encrypted_content"] = "cipher",
                },
                new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["phase"] = "final_answer",
                    ["content"] = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "output_text",
                            ["text"] = "hello",
                            ["annotations"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "url_citation",
                                    ["url"] = "https://example.test",
                                }
                            ),
                        },
                        new JsonObject { ["type"] = "refusal", ["refusal"] = " limited" }
                    ),
                }
            ),
            ["usage"] = new JsonObject
            {
                ["input_tokens"] = 13,
                ["input_tokens_details"] = new JsonObject { ["cached_tokens"] = 3 },
                ["output_tokens"] = 7,
                ["output_tokens_details"] = new JsonObject { ["reasoning_tokens"] = 2 },
            },
        };
        var sse = Encoding.UTF8.GetBytes(
            $"data: {{\"type\":\"response.completed\",\"response\":{response.ToJsonString()}}}\n\n"
        );
        await using var server = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    sse,
                    1,
                    2,
                    5,
                    11,
                    17
                )
        );
        using var http = new HttpClient();
        var service = NewService(http, server.BaseUri);
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, service);
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("question"));

        await registry.Runner.ProcessQueueAsync("s");

        var request = await server.Request.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("POST /v1/responses HTTP/1.1", request.RequestLine);
        Assert.Equal("Bearer test-token", request.Headers["Authorization"]);
        var requestJson = JsonNode.Parse(request.Body) as JsonObject;
        Assert.NotNull(requestJson);
        Assert.Equal("test-model", requestJson!["model"]?.GetValue<string>());
        Assert.Equal("instructions", requestJson["instructions"]?.GetValue<string>());
        Assert.Equal(321, requestJson["max_output_tokens"]?.GetValue<int>());
        Assert.True(requestJson["stream"]?.GetValue<bool>());
        Assert.Equal("auto", requestJson["tool_choice"]?.GetValue<string>());
        Assert.True(requestJson["parallel_tool_calls"]?.GetValue<bool>());
        var tools = Assert.IsType<JsonArray>(requestJson["tools"]);
        var tool = Assert.IsType<JsonObject>(Assert.Single(tools));
        Assert.Equal("function", tool["type"]?.GetValue<string>());
        Assert.Equal("write_fixture", tool["name"]?.GetValue<string>());
        Assert.False(tool["strict"]?.GetValue<bool>());
        var parameters = Assert.IsType<JsonObject>(tool["parameters"]);
        Assert.False(parameters["additionalProperties"]?.GetValue<bool>());
        Assert.Equal(
            new[] { "fileName", "content" },
            Assert
                .IsType<JsonArray>(parameters["required"])
                .Select(node => node!.GetValue<string>())
        );
        var properties = Assert.IsType<JsonObject>(parameters["properties"]);
        Assert.Equal("string", properties["fileName"]?["type"]?.GetValue<string>());
        Assert.Equal("string", properties["content"]?["type"]?.GetValue<string>());
        var requestInput = Assert.IsType<JsonArray>(requestJson["input"]);
        Assert.Single(requestInput);
        Assert.Equal(2, Assert.IsType<JsonArray>(requestInput[0]!["content"]).Count);

        Assert.Equal(1, server.RequestCount);
        var snapshot = entry.Snapshot();
        Assert.Equal(2, snapshot.History.Count);
        var assistant = snapshot.History[1];
        Assert.Equal("model", assistant["role"]?.GetValue<string>());
        var parts = Assert.IsType<JsonArray>(assistant["parts"]);
        Assert.Equal(3, parts.Count);
        Assert.Equal("considered", parts[0]?["thinking"]?.GetValue<string>());
        Assert.Equal("cipher", parts[0]?["providerMeta"]?["encryptedThinking"]?.GetValue<string>());
        Assert.Equal("hello", parts[1]?["text"]?.GetValue<string>());
        Assert.Equal("final_answer", parts[1]?["phase"]?.GetValue<string>());
        Assert.Equal(" limited", parts[2]?["text"]?.GetValue<string>());
        Assert.Equal(10, assistant["__meta"]?["usage"]?["inputTokens"]?.GetValue<long>());
        Assert.Equal(3, assistant["__meta"]?["usage"]?["cachedTokens"]?.GetValue<long>());
        Assert.Equal(7, assistant["__meta"]?["usage"]?["outputTokens"]?.GetValue<long>());
        Assert.Equal(2, assistant["__meta"]?["usage"]?["reasoningTokens"]?.GetValue<long>());
        Assert.Equal("openai/test-model", assistant["__meta"]?["modelId"]?.GetValue<string>());
        Assert.True(
            assistant["__meta"]?["llmRequestTiming"]?["durationMs"]?.GetValue<double>() >= 0
        );
        var stored = await store.LoadAsync("s");
        Assert.Equal(assistant.ToJsonString(), stored?.History[1].ToJsonString());
    }

    [Fact]
    public async Task StopCancelsHeldHttpBodyAndServerObservesConnectionClose()
    {
        var root = NewTempDirectory();
        try
        {
            var headersSent = NewSignal<bool>();
            var closed = NewSignal<bool>();
            await using var server = new LoopbackResponsesServer(
                async (stream, _) =>
                {
                    await stream.WriteAsync(
                        Encoding.ASCII.GetBytes(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n"
                        )
                    );
                    await stream.FlushAsync();
                    headersSent.TrySetResult(true);
                    var buffer = new byte[128];
                    while (await stream.ReadAsync(buffer) != 0) { }
                    closed.TrySetResult(true);
                }
            );
            using var http = new HttpClient();
            var store = new InMemorySessionAuthorityStore();
            var executor = new WriteFixtureToolExecutor(root);
            var registry = new SessionRegistry(store, NewService(http, server.BaseUri), executor);
            var entry = registry.Add("s");
            entry.State.Queue.Add(QueueItem.UserText("cancel"));

            var run = registry.Runner.ProcessQueueAsync("s");
            await headersSent.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await registry.Control.StopAsync("s");
            await run.WaitAsync(TimeSpan.FromSeconds(5));
            await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(1, server.RequestCount);
            Assert.DoesNotContain(
                entry.Snapshot().History,
                message => message["role"]?.GetValue<string>() == "model"
            );
            Assert.False(entry.Snapshot().Busy);
            Assert.Equal(0, executor.SuccessfulEffects);
            Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task NonSuccessReadsBoundedBodyAndCreatesNoAssistant()
    {
        var body = Encoding.UTF8.GetBytes(new string('x', 70_000));
        await using var server = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(stream, 429, "text/plain", body)
        );
        using var http = new HttpClient();
        var service = NewService(http, server.BaseUri);
        var error = await Assert.ThrowsAsync<ResponsesHttpException>(() =>
            service.ChatAsync("s", [UserMessage("request")], CancellationToken.None)
        );

        Assert.Equal(HttpStatusCode.TooManyRequests, error.StatusCode);
        Assert.Equal(64 * 1024, Encoding.UTF8.GetByteCount(error.ResponseBody));
        Assert.True(error.BodyTruncated);
        Assert.Equal(1, server.RequestCount);
    }

    [Theory]
    [InlineData(
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"partial\"}\n\n",
        typeof(ResponsesStreamException)
    )]
    [InlineData("data: {bad}\n\n", typeof(MalformedSseEventJsonException))]
    public async Task IncompleteOrMalformedSseCreatesNoAssistant(string bodyText, Type expectedType)
    {
        var body = Encoding.UTF8.GetBytes(bodyText);
        await using var server = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    body,
                    2,
                    3,
                    5
                )
        );
        using var http = new HttpClient();
        var service = NewService(http, server.BaseUri);

        var error = await Record.ExceptionAsync(() =>
            service.ChatAsync("s", [UserMessage("request")], CancellationToken.None)
        );

        Assert.NotNull(error);
        Assert.IsAssignableFrom(expectedType, error);
        Assert.Equal(1, server.RequestCount);
    }

    [Fact]
    public async Task FunctionCallWithoutStableIdIsControlledUnsupportedAndNotPersisted()
    {
        var completed =
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"name\":\"write_fixture\",\"arguments\":\"{}\"}]}}\n\n";
        await using var server = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(completed)
                )
        );
        using var http = new HttpClient();
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, NewService(http, server.BaseUri));
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("tool please"));

        await registry.Runner.ProcessQueueAsync("s");

        Assert.Equal(1, server.RequestCount);
        Assert.DoesNotContain(
            entry.Snapshot().History,
            message => message["role"]?.GetValue<string>() == "model"
        );
        Assert.Single(entry.Snapshot().History);
    }

    [Fact]
    public async Task EmptyCompletedOutputDoesNotFabricateAssistant()
    {
        var completed =
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n";
        await using var server = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(completed)
                )
        );
        using var http = new HttpClient();
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, NewService(http, server.BaseUri));
        var entry = registry.Add("s");
        entry.State.Queue.Add(QueueItem.UserText("empty is allowed"));

        await registry.Runner.ProcessQueueAsync("s");

        Assert.Equal(1, server.RequestCount);
        Assert.Single(entry.Snapshot().History);
        Assert.Equal("user", entry.Snapshot().History[0]["role"]?.GetValue<string>());
        Assert.Equal(1, entry.Snapshot().AuthorityEnvelope["stats"]!["totalInputTokens"]!.GetValue<double>());
    }

    [Fact]
    public async Task AssistantStrictSaveFailureDoesNotRepeatHttpOrLeaveHotAssistant()
    {
        var root = NewTempDirectory();
        try
        {
            var completed = CompletedSse(
                new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "call_never",
                        ["name"] = "write_fixture",
                        ["arguments"] = "{\"fileName\":\"never.txt\",\"content\":\"never\"}",
                    }
                )
            );
            await using var server = new LoopbackResponsesServer(
                (stream, _) =>
                    LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(completed)
                    )
            );
            using var http = new HttpClient();
            var persistenceRoot = Path.Combine(root, "persistence");
            var store = new PersistentSessionAuthorityStore(
                persistenceRoot,
                "s",
                canonicalCommitBarrier: (ordinal, _) =>
                    ordinal == 2
                        ? Task.FromException(new IOException("strict assistant save failed"))
                        : Task.CompletedTask
            );
            var executor = new WriteFixtureToolExecutor(root);
            var registry = new SessionRegistry(store, NewService(http, server.BaseUri), executor);
            var entry = registry.Add("s");
            entry.State.Queue.Add(QueueItem.UserText("request"));

            await registry.Runner.ProcessQueueAsync("s");

            Assert.Equal(1, server.RequestCount);
            Assert.DoesNotContain(
                entry.Snapshot().History,
                message => message["role"]?.GetValue<string>() == "model"
            );
            var stored = await store.LoadAsync("s");
            Assert.NotNull(stored);
            Assert.DoesNotContain(
                stored!.History,
                message => message["role"]?.GetValue<string>() == "model"
            );
            Assert.Single(store.Archive.ReadMessages());
            Assert.False(entry.Snapshot().Busy);
            Assert.Equal(0, executor.SuccessfulEffects);
            Assert.False(File.Exists(Path.Combine(root, "never.txt")));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task ToolResponseSaveFailureKeepsOneEffectButDoesNotReexecuteOrSendSecondRequest()
    {
        var root = NewTempDirectory();
        try
        {
            var completed = CompletedSse(
                new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "function_call",
                        ["call_id"] = "call_once",
                        ["name"] = "write_fixture",
                        ["arguments"] = "{\"fileName\":\"once.txt\",\"content\":\"once\"}",
                    }
                )
            );
            await using var server = new LoopbackResponsesServer(
                (stream, _) =>
                    LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(completed)
                    )
            );
            using var http = new HttpClient();
            var persistenceRoot = Path.Combine(root, "persistence");
            var store = new PersistentSessionAuthorityStore(
                persistenceRoot,
                "s",
                canonicalCommitBarrier: (ordinal, _) =>
                    ordinal == 3
                        ? Task.FromException(new IOException("strict tool response save failed"))
                        : Task.CompletedTask
            );
            var executor = new WriteFixtureToolExecutor(root);
            var registry = new SessionRegistry(store, NewService(http, server.BaseUri), executor);
            var entry = registry.Add("s");
            entry.State.Queue.Add(QueueItem.UserText("request"));

            await registry.Runner.ProcessQueueAsync("s");

            Assert.Equal(1, server.RequestCount);
            Assert.Equal(1, executor.SuccessfulEffects);
            Assert.Equal("once", await File.ReadAllTextAsync(Path.Combine(root, "once.txt")));
            Assert.Equal(
                new[] { "user", "model" },
                entry.Snapshot().History.Select(message => message["role"]!.GetValue<string>())
            );
            Assert.Equal(2, store.Archive.ReadMessages().Count);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("a/b")]
    [InlineData("a\\b")]
    [InlineData("/absolute")]
    [InlineData("bad\0name")]
    public async Task WriteFixtureRejectsInvalidFileNamesWithoutEffect(string fileName)
    {
        var root = NewTempDirectory();
        try
        {
            var executor = new WriteFixtureToolExecutor(root);
            var response = await executor.ExecuteAsync(
                FunctionCall(
                    "c",
                    "write_fixture",
                    new JsonObject { ["fileName"] = fileName, ["content"] = "no" }
                ),
                CancellationToken.None
            );
            Assert.Equal("invalid_path", response["error"]?["type"]?.GetValue<string>());
            Assert.Equal(0, executor.SuccessfulEffects);
            Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task WriteFixtureRejectsExistingFileAndSymlinkWithoutOverwrite()
    {
        var root = NewTempDirectory();
        try
        {
            var executor = new WriteFixtureToolExecutor(root);
            var existing = Path.Combine(root, "existing.txt");
            await File.WriteAllTextAsync(existing, "old");
            var target = Path.Combine(root, "target.txt");
            await File.WriteAllTextAsync(target, "target");
            File.CreateSymbolicLink(Path.Combine(root, "link.txt"), target);

            foreach (var name in new[] { "existing.txt", "link.txt" })
            {
                var response = await executor.ExecuteAsync(
                    FunctionCall(
                        "c",
                        "write_fixture",
                        new JsonObject { ["fileName"] = name, ["content"] = "new" }
                    ),
                    CancellationToken.None
                );
                Assert.Equal("file_exists", response["error"]?["type"]?.GetValue<string>());
            }
            Assert.Equal("old", await File.ReadAllTextAsync(existing));
            Assert.Equal("target", await File.ReadAllTextAsync(target));
            Assert.Equal(0, executor.SuccessfulEffects);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task WriteFixtureRejectsUnknownToolAndInvalidSchemaWithoutEffect()
    {
        var root = NewTempDirectory();
        try
        {
            var executor = new WriteFixtureToolExecutor(root);
            var unknown = await executor.ExecuteAsync(
                FunctionCall(
                    "unknown",
                    "other_tool",
                    new JsonObject { ["fileName"] = "unknown.txt", ["content"] = "no" }
                ),
                CancellationToken.None
            );
            var invalid = await executor.ExecuteAsync(
                FunctionCall(
                    "invalid",
                    "write_fixture",
                    new JsonObject
                    {
                        ["fileName"] = "invalid.txt",
                        ["content"] = "no",
                        ["extra"] = true,
                    }
                ),
                CancellationToken.None
            );

            Assert.Equal("unknown_tool", unknown["error"]?["type"]?.GetValue<string>());
            Assert.Equal("invalid_tool_arguments", invalid["error"]?["type"]?.GetValue<string>());
            Assert.Equal(0, executor.SuccessfulEffects);
            Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task WriteFixtureReportsGeneralIoFailuresWithoutDeletingPossiblePartialFile()
    {
        var root = NewTempDirectory();
        try
        {
            var openExecutor = new WriteFixtureToolExecutor(
                root,
                openNew: _ => throw new IOException("injected open failure")
            );
            var openFailure = await openExecutor.ExecuteAsync(
                FunctionCall(
                    "open",
                    "write_fixture",
                    new JsonObject { ["fileName"] = "open-failure.txt", ["content"] = "no" }
                ),
                CancellationToken.None
            );

            var writeAttempts = 0;
            var writeExecutor = new WriteFixtureToolExecutor(
                root,
                (_, _) =>
                {
                    Interlocked.Increment(ref writeAttempts);
                    return Task.FromException(new IOException("injected write failure"));
                }
            );
            var writeFailure = await writeExecutor.ExecuteAsync(
                FunctionCall(
                    "write",
                    "write_fixture",
                    new JsonObject { ["fileName"] = "partial.txt", ["content"] = "not committed" }
                ),
                CancellationToken.None
            );

            Assert.Equal("tool_io_error", openFailure["error"]?["type"]?.GetValue<string>());
            Assert.Equal("tool_io_error", writeFailure["error"]?["type"]?.GetValue<string>());
            Assert.Equal(1, writeAttempts);
            Assert.Equal(0, openExecutor.SuccessfulEffects);
            Assert.Equal(0, writeExecutor.SuccessfulEffects);
            Assert.False(File.Exists(Path.Combine(root, "open-failure.txt")));
            Assert.True(File.Exists(Path.Combine(root, "partial.txt")));
            Assert.Empty(await File.ReadAllBytesAsync(Path.Combine(root, "partial.txt")));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void Serializer_projects_inline_input_images_without_mutating_open_history()
    {
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["text"] = "kept",
                        ["vendor"] = new JsonObject { ["opaque"] = true },
                        ["inlineData"] = new JsonObject
                        {
                            ["data"] = "AA==",
                            ["mimeType"] = "image/png",
                        },
                    }
                ),
            },
        };
        var before = history[0].ToJsonString();

        var projected = ResponsesRequestSerializer.ConvertHistory(history, "openai/test-model");
        Assert.Equal("input_image", projected[0]!["content"]![1]!["type"]!.ToString());
        Assert.Equal(
            "data:image/png;base64,AA==",
            projected[0]!["content"]![1]!["image_url"]!.ToString()
        );
        Assert.DoesNotContain("vendor", projected.ToJsonString());
        Assert.Equal(before, history[0].ToJsonString());
        var legacy = ResponsesRequestSerializer.ConvertHistory(
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["system"] = "current time = old" }),
                },
            ],
            "openai/test-model"
        );
        Assert.Equal(
            "<foxwarm-system kind=\"time\" localTime=\"old\" />",
            legacy[0]?["content"]?[0]?["text"]?.GetValue<string>()
        );
    }

    [Fact]
    public void CanonicalTimingDerivesFractionalStartFromCompletedWallAndMonotonicDuration()
    {
        var response = new JsonObject
        {
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "output_text", ["text"] = "timed" }
                    ),
                }
            ),
        };

        var assistant = ResponsesCanonicalConverter.ConvertAssistant(
            response,
            "openai/test-model",
            10_000,
            1_234.5
        );

        Assert.NotNull(assistant);
        var timing = Assert.IsType<JsonObject>(assistant!["__meta"]?["llmRequestTiming"]);
        Assert.Equal(8_765.5, timing["startedAt"]?.GetValue<double>());
        Assert.Equal(10_000, timing["completedAt"]?.GetValue<long>());
        Assert.Equal(1_234.5, timing["durationMs"]?.GetValue<double>());
    }

    [Fact]
    public void ActualTypeScriptOrdinarySequenceBuilderPreservesHistoryVersionAndReplacesFalsyTimestamps()
    {
        var root = NewTempDirectory();
        try
        {
            var resultPath = Path.Combine(root, "actual-ts-append-metadata.json");
            RunPersistenceOracle("append-metadata-ts", root, resultPath, "s");
            var result = JsonNode.Parse(File.ReadAllText(resultPath))!.AsObject();
            Assert.Equal(9, result["historyVersion"]!.GetValue<int>());
            Assert.Equal(6, result["nextMessageSeq"]!.GetValue<int>());
            Assert.Equal(
                new[] { 4242, 4242, 4242, 4242, 7 },
                result["timestamps"]!.AsArray().Select(node => node!.GetValue<int>())
            );
            Assert.Equal(
                new[] { 1, 2, 3, 4, 5 },
                result["seqs"]!.AsArray().Select(node => node!.GetValue<int>())
            );
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    private static ResponsesChatService NewService(HttpClient http, Uri baseUri) =>
        new(
            http,
            new ResponsesClientOptions(
                baseUri,
                "test-model",
                "openai/test-model",
                "test-token",
                "instructions",
                321
            )
        );

    private static JsonObject UserMessage(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static JsonObject FunctionCall(string id, string name, JsonObject args) =>
        new()
        {
            ["id"] = id,
            ["name"] = name,
            ["args"] = args.DeepClone(),
        };

    private static string CompletedSse(JsonArray output) =>
        $"data: {{\"type\":\"response.completed\",\"response\":{{\"output\":{output.ToJsonString()}}}}}\n\n";

    private static string NewTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"foxwarm-dotnet-fixture-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    internal static void RunPersistenceOracle(
        string mode,
        string root,
        string resultPath,
        string sessionId
    )
    {
        var foxwarmRoot = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT");
        if (string.IsNullOrWhiteSpace(foxwarmRoot))
            throw new InvalidOperationException(
                "FOXWARM_TS_ROOT must point to the current built TypeScript source tree."
            );
        var helper = Path.Combine(
            AppContext.BaseDirectory,
            "..",
            "..",
            "..",
            "..",
            "session-persistence-fixture-ts.mjs"
        );
        helper = Path.GetFullPath(helper);
        var logPath = Path.Combine(root, $"actual-ts-{mode}.log");
        var start = new ProcessStartInfo("node")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(helper);
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add(root);
        start.ArgumentList.Add(resultPath);
        start.ArgumentList.Add("");
        start.ArgumentList.Add(sessionId);
        start.Environment["FOXWARM_TS_ROOT"] = foxwarmRoot;
        using var process =
            Process.Start(start)
            ?? throw new InvalidOperationException(
                "Unable to start actual TypeScript persistence oracle."
            );
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("Actual TypeScript persistence oracle timed out.");
        }
        Task.WaitAll(stdout, stderr);
        var log = stdout.Result + stderr.Result;
        File.WriteAllText(logPath, log);
        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"Actual TypeScript persistence oracle exited {process.ExitCode}: {log}"
            );
    }

    private static TaskCompletionSource<T> NewSignal<T>() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);
}
