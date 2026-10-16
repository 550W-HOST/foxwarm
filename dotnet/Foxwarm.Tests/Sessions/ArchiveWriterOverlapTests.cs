using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ArchiveWriterOverlapTests
{
    [Fact]
    public async Task Authority_validation_and_serialization_run_while_archive_is_pending_but_publication_waits()
    {
        using var temp = new TempDirectory();
        using var owner = SqliteArchiveMessageStore.AcquireWriter(
            Path.Combine(temp.Path, "state", "archive-store.sqlite")
        );
        var prepared = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            canonicalCommitBarrier: (_, _) =>
            {
                prepared.SetResult();
                return Task.CompletedTask;
            }
        );
        await store.CommitAsync(Snapshot([]), SaveKind.Strict);
        var previous = await File.ReadAllTextAsync(store.AuthorityPath);
        owner.Writer.BeforeBatch = () => release.Task;
        var message = Fixture.Message(1, "new row", 1000);
        var commit = store.CommitCanonicalAppendAsync(Snapshot([message]), [message]);
        try
        {
            await prepared.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(commit.IsCompleted);
            Assert.Equal(previous, await File.ReadAllTextAsync(store.AuthorityPath));
            Assert.Empty(store.Archive.ReadMessages());
        }
        finally
        {
            release.TrySetResult();
        }
        await commit.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Single((await store.LoadAsync("s"))!.History);
        Assert.Single(store.Archive.ReadMessages());
    }

    [Fact]
    public async Task Failed_authority_preparation_waits_for_accepted_archive_work_then_compensates_only_new_rows()
    {
        using var temp = new TempDirectory();
        using var owner = SqliteArchiveMessageStore.AcquireWriter(
            Path.Combine(temp.Path, "state", "archive-store.sqlite")
        );
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var existing = Fixture.Message(1, "existing", 1000);
        await store.CommitCanonicalAppendAsync(Snapshot([existing]), [existing]);
        var previous = await File.ReadAllTextAsync(store.AuthorityPath);
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.Writer.BeforeBatch = () =>
        {
            held.TrySetResult();
            return release.Task;
        };
        var added = Fixture.Message(2, "new row", 2000);
        var bad = Snapshot([existing, added]);
        bad.AuthorityEnvelope["childHandoffState"] = new JsonObject();
        var commit = store.CommitCanonicalAppendAsync(bad, [existing, added]);
        try
        {
            await held.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(commit.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            commit.WaitAsync(TimeSpan.FromSeconds(5))
        );
        Assert.Equal(previous, await File.ReadAllTextAsync(store.AuthorityPath));
        Assert.Equal(
            "existing",
            Assert.Single(store.Archive.ReadMessages()).Message["parts"]![0]![
                "text"
            ]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Independent_adapters_share_batches_and_conflicts_do_not_remove_successful_commands()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "archive.sqlite");
        using var owner = SqliteArchiveMessageStore.AcquireWriter(path);
        var a = new SqliteArchiveMessageStore(path, "a");
        var b = new SqliteArchiveMessageStore(path, "b");
        a.Initialize();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.Writer.BeforeBatch = () => release.Task;
        ArchiveMessageRecord Row(string id, int seq, string text) =>
            ArchiveMessageRecord.Create(
                id,
                "main",
                seq,
                seq * 1000,
                Fixture.Message(seq, text, seq * 1000)
            );
        var first = await a.EnqueueMessagesAsync([Row("a", 1, "one")]);
        var rejected = await a.EnqueueMessagesAsync([
            Row("a", 2, "must roll back"),
            Row("a", 1, "conflict"),
        ]);
        var unrelated = await b.EnqueueMessagesAsync([Row("b", 1, "other")]);
        release.SetResult();
        Assert.Single(await first.Completion);
        await Assert.ThrowsAsync<InvalidDataException>(() => rejected.Completion);
        Assert.Single(await unrelated.Completion);
        Assert.Equal(1, owner.Writer.CommittedBatches);
        Assert.Equal(3, owner.Writer.LargestBatch);
        Assert.Single(a.ReadMessages());
        Assert.Single(b.ReadMessages());
    }

    [Fact]
    public async Task Queued_message_owns_validated_raw_values_even_if_the_input_object_changes()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "archive.sqlite");
        using var owner = SqliteArchiveMessageStore.AcquireWriter(path);
        var store = new SqliteArchiveMessageStore(path, "s");
        store.Initialize();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        owner.Writer.BeforeBatch = () => release.Task;
        var message = Fixture.Message(1, "owned", 1000);
        var row = ArchiveMessageRecord.Create("s", "main", 1, 1000, message);
        var receipt = await store.EnqueueMessagesAsync([row]);
        row.Message["parts"]![0]!["text"] = "changed after admission";
        release.SetResult();
        var inserted = Assert.Single(await receipt.Completion);
        Assert.Equal("owned", inserted.Message["parts"]![0]!["text"]!.GetValue<string>());
        store.RollbackInsertedMessages([inserted]);
        Assert.Empty(store.ReadMessages());
    }

    private static SessionSnapshot Snapshot(IReadOnlyList<JsonObject> messages) =>
        new("s", messages, [], false, null, false, new(), messages.Count + 1, 0, new());
}
