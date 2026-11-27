using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests.Models;

// The writer lane as model requests use it (moved from JournalWriterOverlapTests).
public abstract partial class LlmJournalContractTests
{
    [Fact]
    public async Task Concrete_preparation_progresses_while_manifest_commit_is_held_but_transport_waits()
    {
        await using var backend = await CreateAsync();
        await using var journal = backend.Open();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(journal, () => release.Task);
        var prepared = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var sends = 0;
        using var http = new HttpClient(new Handler(() => Interlocked.Increment(ref sends)));
        var request = Owner(http, journal)
            .RequestAsync(
                "s",
                Catalog(),
                "model",
                null,
                "cache",
                "turn",
                History(),
                (_, _) => Task.FromResult("prompt"),
                null,
                () => prepared.SetResult(),
                null,
                null,
                CancellationToken.None
            );
        try
        {
            await prepared.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(request.IsCompleted);
            Assert.Equal(0, Volatile.Read(ref sends));
        }
        finally
        {
            release.TrySetResult();
        }
        var result = await request.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, sends);
        Assert.NotNull(result.JournalRequestId);
        var restored = await journal.ReconstructAsync(result.JournalRequestId);
        Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
        Assert.Single(restored["attempts"]!.AsArray());
    }

    [Fact]
    public async Task Manifest_and_attempt_can_share_one_commit_and_depend_on_earlier_commands_in_that_batch()
    {
        await using var backend = await CreateAsync();
        await using var journal = backend.Open();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(journal, () => release.Task);
        var request = await journal.EnqueueRequestAsync(
            "s",
            "test",
            0,
            "prompt",
            new(),
            History(),
            "model",
            "cache"
        );
        var badStart = await journal.EnqueueAttemptStartAsync(
            request.RequestId,
            1,
            "model",
            null,
            "anthropic",
            new JsonObject(),
            "wrong prompt"
        );
        var goodStart = await journal.EnqueueAttemptStartAsync(
            request.RequestId,
            1,
            "model",
            null,
            "anthropic",
            new JsonObject(),
            "prompt"
        );
        var result = await journal.EnqueueAttemptResultAsync(
            request.RequestId,
            1,
            "success",
            new JsonObject { ["text"] = "done" },
            null
        );
        Assert.False(request.Completion.IsCompleted);
        release.SetResult();
        await request.Completion;
        await Assert.ThrowsAsync<InvalidDataException>(() => badStart.Completion);
        await Task.WhenAll(goodStart.Completion, result.Completion);
        Assert.Equal(1, backend.CommittedBatches(journal));
        Assert.Equal(4, backend.LargestBatch(journal));
        var restored = await journal.ReconstructAsync(request.RequestId);
        Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
        Assert.Single(restored["attempts"]!.AsArray());
    }

    [Fact]
    public async Task Failed_manifest_and_start_do_not_allow_dependent_commands_to_succeed()
    {
        await using var backend = await CreateAsync();
        await using var journal = backend.Open();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(journal, () => release.Task);
        using var cancel = new CancellationTokenSource();
        var request = await journal.EnqueueRequestAsync(
            "s",
            "test",
            0,
            "prompt",
            new(),
            History(),
            "model",
            "cache",
            cancel.Token
        );
        var start = await journal.EnqueueAttemptStartAsync(
            request.RequestId,
            1,
            "model",
            null,
            "anthropic",
            new JsonObject(),
            "prompt"
        );
        var result = await journal.EnqueueAttemptResultAsync(
            request.RequestId,
            1,
            "success",
            new JsonObject(),
            null
        );
        cancel.Cancel();
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request.Completion);
        await Assert.ThrowsAsync<InvalidDataException>(() => start.Completion);
        await Assert.ThrowsAsync<InvalidDataException>(() => result.Completion);
        Assert.Empty(await journal.ListAsync("s", null, null, null, 10));
    }

    [Fact]
    public async Task Local_preparation_failure_resolves_the_accepted_manifest_before_returning()
    {
        await using var backend = await CreateAsync();
        await using var journal = backend.Open();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(journal, () => release.Task);
        var failedPreparation = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var sends = 0;
        using var http = new HttpClient(new Handler(() => Interlocked.Increment(ref sends)));
        var request = Owner(http, journal)
            .RequestAsync(
                "s",
                Catalog(),
                "model",
                null,
                "cache",
                "turn",
                History(),
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                CancellationToken.None,
                journalRequestStarted: _ =>
                {
                    failedPreparation.SetResult();
                    throw new InvalidOperationException("Local preparation failed.");
                }
            );
        try
        {
            await failedPreparation.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(request.IsCompleted);
            Assert.Equal(0, sends);
        }
        finally
        {
            release.TrySetResult();
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            request.WaitAsync(TimeSpan.FromSeconds(5))
        );
        var restored = await journal.ReconstructAsync(
            Assert.Single(await journal.ListAsync("s", null, null, null, 10))![
                "requestId"
            ]!.GetValue<string>()
        );
        Assert.Empty(restored["attempts"]!.AsArray());
    }

    [Fact]
    public async Task Cancelling_after_concrete_plan_while_manifest_is_queued_preserves_durable_abort()
    {
        await using var backend = await CreateAsync();
        await using var journal = backend.Open();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        backend.BeforeBatch(journal, () => release.Task);
        var prepared = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancel = new CancellationTokenSource();
        var sends = 0;
        using var http = new HttpClient(new Handler(() => Interlocked.Increment(ref sends)));
        var request = Owner(http, journal)
            .RequestAsync(
                "s",
                Catalog(),
                "model",
                null,
                "cache",
                "turn",
                History(),
                (_, _) => Task.FromResult("prompt"),
                null,
                () => prepared.SetResult(),
                null,
                null,
                cancel.Token
            );
        try
        {
            await prepared.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancel.Cancel();
            Assert.False(request.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            request.WaitAsync(TimeSpan.FromSeconds(5))
        );
        Assert.Equal(0, sends);
        var row = Assert.Single(await journal.ListAsync("s", null, null, null, 10));
        var restored = await journal.ReconstructAsync(row!["requestId"]!.GetValue<string>());
        Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
        Assert.Equal(
            "abort",
            Assert.Single(restored["attempts"]!.AsArray())!["result"]![
                "outcome"
            ]!.GetValue<string>()
        );
    }

    private static ModelRequestOwner Owner(HttpClient http, ILlmJournalStore journal) =>
        TestModelOwners.Create(
            http,
            new ResponsesClientOptions(
                new Uri("http://localhost"),
                "model",
                "model",
                "token",
                "",
                50
            ),
            new ModelRouting(),
            journal: journal
        );

    private static HostModels Catalog() =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"model","providers":{"model":{"providerType":"anthropic","extraFields":{"stream":false},"baseUrl":"http://localhost","apiKey":"token","models":["model"]}}}
                    """
                )!
                .AsObject(),
            new JsonObject()
        );

    private sealed class Handler(Action send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            send();
            return Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                    ),
                }
            );
        }
    }
}
