using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests.Models;

// The shared root writer of the file journal; the writer contract cases are in
// LlmJournalContractTests.
public sealed class JournalWriterOverlapTests
{
    [Fact]
    public async Task Stores_share_one_root_owner_and_disposing_one_does_not_close_another_producer()
    {
        using var temp = new TempDirectory();
        var first = new LlmRequestJournalStore(temp.Path);
        await using var second = new LlmRequestJournalStore(temp.Path);
        Assert.Same(first.Writer, second.Writer);
        await first.DisposeAsync();
        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            first.BeginRequestAsync("s", "test", 0, "prompt", new(), History(), "model", "cache")
        );
        var id = await second.BeginRequestAsync(
            "s",
            "test",
            0,
            "prompt",
            new(),
            History(),
            "model",
            "cache"
        );
        Assert.Equal(
            "complete",
            (await second.ReconstructAsync(id))["completeness"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Last_owner_disposal_drains_accepted_work_before_a_reopened_root_can_replace_it()
    {
        using var temp = new TempDirectory();
        var first = new LlmRequestJournalStore(temp.Path);
        var oldWriter = first.Writer;
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        oldWriter.BeforeBatch = () =>
        {
            held.TrySetResult();
            return release.Task;
        };
        var admitted = await first.EnqueueRequestAsync(
            "s",
            "test",
            0,
            "prompt",
            new(),
            History(),
            "model",
            "cache"
        );
        await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var disposal = first.DisposeAsync().AsTask();
        var reopening = Task.Run(() => new LlmRequestJournalStore(temp.Path));
        try
        {
            Assert.False(disposal.IsCompleted);
            Assert.False(admitted.Completion.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        await disposal.WaitAsync(TimeSpan.FromSeconds(5));
        await admitted.Completion;
        await using var reopened = await reopening.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotSame(oldWriter, reopened.Writer);
        Assert.Equal(
            "complete",
            (await reopened.ReconstructAsync(admitted.RequestId))[
                "completeness"
            ]!.GetValue<string>()
        );
    }

    private static IReadOnlyList<JsonObject> History() =>
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "hello" }),
            },
        ];
}
