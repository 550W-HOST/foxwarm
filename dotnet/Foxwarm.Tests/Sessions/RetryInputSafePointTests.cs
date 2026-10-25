using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class RetryInputSafePointTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task WaitFor(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
            await Task.Delay(5, timeout.Token);
    }

    private static Task Reply(System.Net.Sockets.NetworkStream stream, int status, string text) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            status,
            status == 200 ? "text/event-stream" : "application/json",
            Encoding.UTF8.GetBytes(
                status == 200
                    ? "data: "
                        + new JsonObject
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
                                                ["text"] = text,
                                            }
                                        ),
                                    }
                                ),
                            },
                        }.ToJsonString()
                        + "\n\n"
                    : "{\"error\":{\"message\":\"synthetic failure\"}}"
            )
        );

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;

        internal Func<string, int, CancellationToken, Task>? CanonicalStage;

        internal static async Task<Fixture> Create(Uri uri)
        {
            var fixture = new Fixture();
            Console.WriteLine("Owned retry input fixture=" + fixture.Temp.Path);
            try
            {
                var options = new ResponsesClientOptions(uri, "wire", "a", "", "", 713);
                fixture.Manager = new(
                    fixture.Data,
                    Path.Combine(fixture.Temp.Path, "work"),
                    options,
                    HostModels.ForTest(options),
                    canonicalCommitBarrier: (id, commit, token) => fixture.CanonicalStage?.Invoke(id, commit, token) ?? Task.CompletedTask
                );
                await fixture.Manager.LoadAsync();
                fixture.Owner = await fixture.Manager.CreateNamedAsync("main", "retry", null, null);
                fixture.Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        internal Task Enqueue(string text) =>
            Owner.Registry.Ingress.EnqueueAsync(
                Owner.Id,
                new QueueItem(
                    QueueItemType.User,
                    SessionBoundary.ChannelInput([new JsonObject { ["text"] = text }], "webui"),
                    ClientMessageId: text
                )
            );

        internal Task Run() => Owner.Registry.Runner.ProcessQueueAsync(Owner.Id);

        public async ValueTask DisposeAsync()
        {
            if (Manager is not null)
            {
                await Manager.ShutdownAsync();
                await Manager.DisposeAsync();
            }
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Real_backoff_then_strict_finite_bulk_input_does_not_take_late_arrival_or_replay_output()
    {
        var errorRelease = Signal();
        var responseRelease = Signal();
        var failedAt = 0L;
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
            {
                if (index == 0)
                {
                    await errorRelease.Task;
                    failedAt = Stopwatch.GetTimestamp();
                    await Reply(stream, 503, "");
                }
                else
                {
                    if (index == 1)
                        await responseRelease.Task;
                    await Reply(stream, 200, index == 1 ? "committed-intermediate" : "final");
                }
            }
        );
        await using var f = await Fixture.Create(peer.BaseUri);
        var appendReached = Signal();
        var appendRelease = Signal();
        try
        {
            await f.Enqueue("seed");
            var running = f.Run();
            await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
            var initialIdentity = f.Owner.DraftSnapshot()["llmRequestId"]!.GetValue<string>();
            await f.Enqueue("queued-one");
            await f.Owner.Registry.Ingress.EnqueueAsync(
                f.Owner.Id,
                new QueueItem(
                    QueueItemType.Background,
                    Message: new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["system"] = "queued-two" }),
                    },
                    ClientMessageId: "queued-two"
                )
            );
            await f.Enqueue("queued-three");
            errorRelease.TrySetResult();
            await WaitFor(() =>
                f
                    .Owner.Entry.Snapshot()
                    .History.Materialize()
                    .Any(row => row["__meta"]?["noticeType"]?.GetValue<string>() == "llm-retry")
            );
            f.CanonicalStage = async (_, _, _) =>
            {
                appendReached.TrySetResult();
                await appendRelease.Task;
            };
            await appendReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.True(Stopwatch.GetElapsedTime(failedAt).TotalMilliseconds >= 1900);
            var late = f.Enqueue("late-input");
            Assert.False(late.IsCompleted);
            appendRelease.TrySetResult();
            await late;
            var second = await peer.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains("queued-one", second.Body);
            Assert.Contains("queued-two", second.Body);
            Assert.Contains("queued-three", second.Body);
            Assert.DoesNotContain("late-input", second.Body);
            Assert.NotEqual(
                initialIdentity,
                f.Owner.DraftSnapshot()["llmRequestId"]!.GetValue<string>()
            );
            responseRelease.TrySetResult();
            await running.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Contains("late-input", (await peer.RequestAt(2)).Body);
            var state = f.Owner.Entry.Snapshot();
            Assert.Empty(state.Queue);
            var inputRows = state.History.Materialize();
            Assert.DoesNotContain(
                "queueInputHint",
                inputRows
                    .Single(row => SessionWait.Text(row["__meta"]?["clientMessageId"]) == "seed")
                    .ToJsonString()
            );
            Assert.Contains(
                "queueInputHint",
                inputRows
                    .Single(row =>
                        SessionWait.Text(row["__meta"]?["clientMessageId"]) == "queued-one"
                    )
                    .ToJsonString()
            );
            Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
            var journal = await f.Manager.Journal.ListAsync(
                f.Owner.Id,
                "normal-turn",
                null,
                null,
                10
            );
            Assert.Equal(3, journal.Count);
            Assert.Equal(
                0,
                journal.Single(row => SessionWait.Text(row!["requestId"]) == initialIdentity)![
                    "iteration"
                ]!.GetValue<int>()
            );
            var answers = state
                .History.Materialize()
                .Where(row =>
                    row["role"]?.GetValue<string>() == "model"
                    && row["modelVisible"]?.GetValue<bool>() != false
                )
                .ToArray();
            Assert.Equal(
                new[] { 0, 1 },
                answers.Select(answer =>
                    journal.Single(row =>
                        SessionWait.Text(row!["requestId"])
                        == SessionWait.Text(answer["__meta"]?["llmRequestId"])
                    )!["iteration"]!.GetValue<int>()
                )
            );
            Assert.Equal(
                new[] { "seed", "queued-one", "queued-two", "queued-three", "late-input" },
                state
                    .History.Materialize()
                    .Where(row => row["role"]?.GetValue<string>() == "user")
                    .Select(row => row["parts"]!.ToJsonString())
                    .Select(text =>
                        new[]
                        {
                            "seed",
                            "queued-one",
                            "queued-two",
                            "queued-three",
                            "late-input",
                        }.Single(text.Contains)
                    )
            );
            Assert.Equal(
                2,
                state
                    .History.Materialize()
                    .Count(row =>
                        row["role"]?.GetValue<string>() == "model"
                        && row["modelVisible"]?.GetValue<bool>() != false
                    )
            );
        }
        finally
        {
            errorRelease.TrySetResult();
            responseRelease.TrySetResult();
            appendRelease.TrySetResult();
        }
    }

    [Fact]
    public async Task Six_physical_attempt_budget_remains_six_after_five_real_context_rebuilds()
    {
        Fixture? fixture = null;
        var times = new List<long>();
        var keys = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(
            6,
            async (index, stream, request) =>
            {
                times.Add(Stopwatch.GetTimestamp());
                keys.Add(
                    fixture!.Owner.Entry.Snapshot().AuthorityEnvelope[
                        "promptCacheKey"
                    ]!.GetValue<string>()
                );
                if (index > 0)
                    Assert.Contains("budget-input-" + index, request.Body);
                if (index < 5)
                    await fixture.Enqueue("budget-input-" + (index + 1));
                await Reply(stream, 503, "");
            }
        );
        await using var owned = await Fixture.Create(peer.BaseUri);
        fixture = owned;
        await owned.Enqueue("budget-seed");
        await owned.Run().WaitAsync(TimeSpan.FromSeconds(110));
        Assert.Equal(6, peer.RequestCount);
        Assert.IsType<ModelRequestException>(owned.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Single(keys.Distinct());
        Assert.Empty(owned.Owner.Entry.Snapshot().Queue);
        Assert.Equal(
            6,
            owned
                .Owner.Entry.Snapshot()
                .History.Materialize()
                .Count(row => row["role"]?.GetValue<string>() == "user")
        );
        for (var index = 1; index < 6; index++)
            Assert.True(
                Stopwatch.GetElapsedTime(times[index - 1], times[index]).TotalMilliseconds
                    >= ModelRequestOwner.RetryDelay(index) - 100
            );
    }

    [Fact]
    public async Task Unchanged_retry_context_gets_new_stream_but_keeps_the_same_logical_request_identity()
    {
        var first = Signal();
        var second = Signal();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                await (index == 0 ? first.Task : second.Task);
                await Reply(stream, index == 0 ? 503 : 200, "done");
            }
        );
        await using var fixture = await Fixture.Create(peer.BaseUri);
        try
        {
            await fixture.Enqueue("unchanged");
            var run = fixture.Run();
            await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(5));
            var before = fixture.Owner.DraftSnapshot();
            first.TrySetResult();
            await peer.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(5));
            var after = fixture.Owner.DraftSnapshot();
            Assert.Equal(
                before["llmRequestId"]!.GetValue<string>(),
                after["llmRequestId"]!.GetValue<string>()
            );
            Assert.NotEqual(
                before["streamId"]!.GetValue<string>(),
                after["streamId"]!.GetValue<string>()
            );
            second.TrySetResult();
            await run;
            Assert.Equal(2, peer.RequestCount);
            Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        }
        finally
        {
            first.TrySetResult();
            second.TrySetResult();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_or_RunQueued_during_real_retry_append_await_does_not_send_the_old_request(
        bool runQueued
    )
    {
        var errorRelease = Signal();
        await using var peer = new ScriptedResponsesSequenceServer(
            runQueued ? 2 : 1,
            async (index, stream, _) =>
            {
                if (index == 0)
                {
                    await errorRelease.Task;
                    await Reply(stream, 503, "");
                }
                else
                    await Reply(stream, 200, "queued-run");
            }
        );
        await using var f = await Fixture.Create(peer.BaseUri);
        var appendReached = Signal();
        var appendRelease = Signal();
        try
        {
            await f.Enqueue("seed");
            var running = f.Run();
            await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
            await f.Enqueue("queued");
            errorRelease.TrySetResult();
            await WaitFor(() =>
                f
                    .Owner.Entry.Snapshot()
                    .History.Materialize()
                    .Any(row => row["__meta"]?["noticeType"]?.GetValue<string>() == "llm-retry")
            );
            f.CanonicalStage = async (_, _, _) =>
            {
                appendReached.TrySetResult();
                await appendRelease.Task;
            };
            await appendReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var stopping = runQueued
                ? (Task)f.Owner.Registry.Control.DequeueAsync(f.Owner.Id)
                : f.Owner.Registry.Control.StopAsync(f.Owner.Id);
            appendRelease.TrySetResult();
            await stopping;
            await running.WaitAsync(TimeSpan.FromSeconds(15));
            var state = f.Owner.Entry.Snapshot();
            Assert.False(state.Busy);
            Assert.Empty(state.Queue);
            Assert.Null(f.Owner.Entry.LastBackgroundProcessorFailure);
            Assert.Equal(runQueued ? 2 : 1, peer.RequestCount);
            if (runQueued)
                Assert.Contains("queued", (await peer.RequestAt(1)).Body);
            Assert.Single(
                state.History.Materialize(),
                row => row["__meta"]?["clientMessageId"]?.GetValue<string>() == "queued"
            );
        }
        finally
        {
            errorRelease.TrySetResult();
            appendRelease.TrySetResult();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_pre_or_postrename_retry_bulk_failure_stops_next_provider_send(
        bool committed
    )
    {
        var errorRelease = Signal();
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
            {
                await errorRelease.Task;
                await Reply(stream, 503, "");
            }
        );
        await using var f = await Fixture.Create(peer.BaseUri);
        try
        {
            await f.Enqueue("seed");
            var running = f.Run();
            await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(10));
            await f.Enqueue("queued");
            using (
                var database = new SqliteConnection(
                    $"Data Source={Path.Combine(f.Data, "state", committed ? "catalog.sqlite" : "archive-store.sqlite")}"
                )
            )
            {
                database.Open();
                using var command = database.CreateCommand();
                command.CommandText = committed
                    ? "CREATE TRIGGER retry_input_fault BEFORE UPDATE ON session_catalog WHEN NEW.session_id='retry' AND NEW.message_count>2 BEGIN SELECT RAISE(ABORT,'owned postcommit projection failure'); END"
                    : "CREATE TRIGGER retry_input_fault BEFORE INSERT ON archive_messages WHEN NEW.session_id='retry' AND json_extract(NEW.message_json,'$.__meta.clientMessageId')='queued' BEGIN SELECT RAISE(ABORT,'owned precommit audit failure'); END";
                command.ExecuteNonQuery();
            }
            errorRelease.TrySetResult();
            var releaseFailure = await Record.ExceptionAsync(() =>
                running.WaitAsync(TimeSpan.FromSeconds(15))
            );
            if (committed)
                Assert.IsType<AuthorityCommittedException>(releaseFailure);
            else
                Assert.Null(releaseFailure);
            Assert.Equal(1, peer.RequestCount);
            Assert.IsType<ModelPreparationException>(f.Owner.Entry.LastBackgroundProcessorFailure);
            var saved = JsonNode
                .Parse(
                    await File.ReadAllTextAsync(
                        Path.Combine(f.Data, "state", "sessions", f.Owner.Id + ".json")
                    )
                )!
                .AsObject();
            Assert.Equal(
                committed,
                f.Owner.Entry.Snapshot()
                    .History.Materialize()
                    .Any(row => row["__meta"]?["clientMessageId"]?.GetValue<string>() == "queued")
            );
            Assert.Equal(
                committed,
                saved["history"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Any(row => row["__meta"]?["clientMessageId"]?.GetValue<string>() == "queued")
            );
            Assert.Equal(committed ? 0 : 1, f.Owner.Entry.Snapshot().Queue.Count);
        }
        finally
        {
            errorRelease.TrySetResult();
            using var database = new SqliteConnection(
                $"Data Source={Path.Combine(f.Data, "state", committed ? "catalog.sqlite" : "archive-store.sqlite")}"
            );
            database.Open();
            using var command = database.CreateCommand();
            command.CommandText = "DROP TRIGGER IF EXISTS retry_input_fault";
            command.ExecuteNonQuery();
        }
    }
}
