using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Authority;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Npgsql;
using static Foxwarm.Tests.SessionAuthorityContractTests;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// What the PostgreSQL Session authority adds to the shared contract: the fence on every
/// write, lost-COMMIT resolution, envelope parts, the segment policy over real rows, head
/// conflicts and compaction cancellation.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class PostgresSessionAuthorityStoreTests : IAsyncLifetime
{
    private readonly TempDirectory temp = new();
    private PgAuthorityFixture fixture = null!;

    public async Task InitializeAsync() => fixture = await PgAuthorityFixture.OpenAsync(temp.Path);

    public async Task DisposeAsync()
    {
        await fixture.DisposeAsync();
        temp.Dispose();
    }

    private PostgresSessionAuthorityBackend Backend => fixture.Backend;

    private ISessionAuthority Open(string id = "s", PostgresSessionAuthorityBackend? backend = null) =>
        (backend ?? Backend).Open(id, "main", new SessionAuthorityCallbacks());

    private static JsonObject Memory(int bytes, char fill = 'm') =>
        new() { ["persistentMemorySnapshot"] = new string(fill, bytes) };

    private static SessionArchiveBlock Block(long id) => new(id);

    private sealed record SessionArchiveBlock(long Id)
    {
        internal ArchiveBlockRecord Record(string session) =>
            new(session, "main", Id, 1, "message", 1, 2, null, 1, 2, 1001, 1002, "summary", null, 1000);
    }

    [Fact]
    public async Task Every_write_is_fenced_after_a_takeover_and_leaves_nothing()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        await Open("other").CommitAsync(Snapshot("other", SessionHistory.Empty, 1), SaveKind.Strict);
        var raw = (JsonObject)(await Backend.ReadRawAsync("s"))!.Document!;
        var before = fixture.Dump();

        await fixture.Database.TakeLeaseAsync(fixture.Tenant.TenantId, "other replica");

        var appended = history.AppendJson([Message(3, "three")]);
        var writes = new (string Name, Func<Task> Write)[]
        {
            ("commit", () => store.CommitAsync(Snapshot("s", history, 3) with { Busy = true, BusyStartedAt = 1 }, SaveKind.Strict)),
            ("append", () => store.CommitCanonicalAppendAsync(Snapshot("s", appended, 4), [Message(3, "three")])),
            (
                "compaction",
                () =>
                    store.CommitCompactionAsync(
                        Snapshot("s", SessionHistory.FromMessages([history[1]]), 3, version: 1),
                        [Block(1).Record("s")],
                        []
                    )
            ),
            ("identity snapshot", () => store.PersistIdentitySnapshotAsync(Snapshot("s", history, 3))),
            ("move", () => Task.Run(() => Backend.MoveIdentity("s", "moved"))),
            ("replace", () => Task.Run(() => Backend.ReplaceRaw("s", raw))),
            ("delete", () => Task.Run(() => Backend.DeleteAuthority("other"))),
            ("new lifetime", () => Open("fresh").CommitAsync(Snapshot("fresh", SessionHistory.Empty, 1), SaveKind.Strict)),
        };
        foreach (var (name, write) in writes)
        {
            var error = await Record.ExceptionAsync(write);
            Assert.True(error is TenantFencedException, name + ": " + error);
            Assert.Equal(before, fixture.Dump());
        }
    }

    [Fact]
    public async Task A_lost_COMMIT_is_resolved_by_its_commit_id_in_both_directions()
    {
        await using var proxy = PgTcpProxy.For(fixture.Database.AppConnectionString);
        var routed = new NpgsqlConnectionStringBuilder(proxy.Route(fixture.Database.AppConnectionString))
        {
            Pooling = false,
            CommandTimeout = 3,
            Timeout = 5,
        }.ConnectionString;
        var tenant = new TenantDb(fixture.Database.OpenApp(routed), fixture.Tenant.TenantId, fixture.Tenant.Epoch);
        var backend = new PostgresSessionAuthorityBackend(tenant, id => new PgArchiveTestReader(tenant, id), temp.Path, null);
        var commits = new List<PgSessionCommitStats>();
        backend.Committed = commits.Add;
        var published = new List<long>();
        var store = backend.Open(
            "s",
            "main",
            new SessionAuthorityCallbacks(PublishProjection: snapshot => published.Add(snapshot.NextMessageSeq))
        );
        void Once(Action action) =>
            backend.BeforeCommit = _ =>
            {
                backend.BeforeCommit = null;
                action();
            };
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));

        // COMMIT reaches the server, its reply doesn't: the commit ID is found, so the commit
        // succeeded, is published, and the store keeps its known head.
        Once(() => proxy.HoldExisting(toServer: false, toClient: true));
        history = await Append(store, history, Message(2, "two"));
        proxy.SeverAll();
        proxy.Heal();
        Assert.Equal([2L, 3L], published);
        Assert.Equal(["one", "two"], Texts((await Open().LoadAsync("s"))!.History));

        // COMMIT never reaches the server: the commit ID isn't found, so it is a precommit
        // failure and its Archive rows went with the transaction.
        Once(() => proxy.HoldExisting(toServer: true, toClient: false));
        var lost = await Record.ExceptionAsync(() => Append(store, history, Message(3, "three")));
        Assert.NotNull(lost);
        Assert.IsNotType<CommitOutcomeUnknownException>(lost);
        proxy.SeverAll();
        proxy.Heal();
        Assert.Equal([2L, 3L], published);
        Assert.Equal(["one", "two"], Texts((await Open().LoadAsync("s"))!.History));
        Assert.Equal(2, fixture.Count("archive_messages"));

        // The store continues from its committed head and writes only the appended record.
        commits.Clear();
        await Append(store, history, Message(3, "three again"));
        Assert.Equal(1, Assert.Single(commits).RecordsWritten);
        Assert.Equal(["one", "two", "three again"], Texts((await Open().LoadAsync("s"))!.History));
    }

    [Fact]
    public async Task Large_top_level_strings_are_parts_written_once_per_value()
    {
        var store = Open();
        var envelope = Memory(10_000);
        envelope["futureLarge"] = new string('f', 5000);
        envelope["small"] = new string('s', 4095);
        var history = History(Message(1, "one"));
        await store.CommitAsync(Snapshot("s", history, 2) with { AuthorityEnvelope = envelope }, SaveKind.Strict);
        Assert.Equal(2, fixture.Count("session_envelope_parts"));
        var first = Assert.Single(fixture.Commits);
        Assert.Equal(2, first.PartsWritten);
        Assert.True(first.EnvelopeBytes < 6000, first.EnvelopeBytes.ToString());

        // An unchanged value isn't written again; a changed one replaces its part.
        fixture.Commits.Clear();
        await store.CommitAsync(Snapshot("s", history, 2) with { AuthorityEnvelope = envelope, Busy = true, BusyStartedAt = 3 }, SaveKind.Strict);
        Assert.Equal(0, Assert.Single(fixture.Commits).PartsWritten);
        var changed = Memory(10_000, 'n');
        changed["futureLarge"] = envelope["futureLarge"]!.DeepClone();
        changed["small"] = envelope["small"]!.DeepClone();
        await store.CommitAsync(Snapshot("s", history, 2) with { AuthorityEnvelope = changed }, SaveKind.Strict);
        Assert.Equal(2, fixture.Count("session_envelope_parts"));

        // The value equals file mode's, member order included.
        using var fileRoot = new TempDirectory();
        var file = new FileStorageContext(fileRoot.Path).Authority;
        await file.Open("s", "main", new SessionAuthorityCallbacks())
            .CommitAsync(Snapshot("s", history, 2) with { AuthorityEnvelope = changed }, SaveKind.Strict);
        var expected = (await file.ReadRawAsync("s"))!.Document!;
        var actual = (await Backend.ReadRawAsync("s"))!.Document!;
        Assert.Equal(expected.ToJsonString(), actual.ToJsonString());
        Assert.Equal(file.ReadEnvelope("s", "main")!.ToJsonString(), Backend.ReadEnvelope("s", "main")!.ToJsonString());
        var loaded = (await Open().LoadAsync("s"))!;
        Assert.Equal(new string('n', 10_000), loaded.AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>());

        // Clearing the member deletes its part in the same commit.
        await store.CommitAsync(Snapshot("s", history, 2), SaveKind.Strict);
        Assert.Equal(0, fixture.Count("session_envelope_parts"));
    }

    [Fact]
    public async Task Small_trailing_segments_merge_and_rewrites_are_cut_into_pieces()
    {
        var store = Open();
        var history = SessionHistory.Empty;
        for (var seq = 1; seq <= SessionSegmentPlanner.MergeRunLength; seq++)
            history = await Append(store, history, Message(seq, "small " + seq));
        Assert.Equal(SessionSegmentPlanner.MergeRunLength, fixture.Count("session_segments"));

        fixture.Commits.Clear();
        history = await Append(store, history, Message(17, "merges"));
        Assert.Equal(17, Assert.Single(fixture.Commits).RecordsWritten);
        Assert.Equal(1, fixture.Count("session_segments"));

        // A rewrite from the first record cuts about 256 KiB pieces.
        var large = new string('x', 40 * 1024);
        var records = Enumerable.Range(18, 20).Select(seq => Message(seq, large)).ToArray();
        history = history.AppendJson(records);
        history = history.Replace(0, HistoryMessage.FromJson(Message(1, "redacted")));
        fixture.Commits.Clear();
        await store.CommitAsync(Snapshot("s", history, 38), SaveKind.Strict);
        Assert.Equal(37, Assert.Single(fixture.Commits).RecordsWritten);
        var sizes = fixture.Tenant.Read(tx =>
        {
            using var command = tx.Command("SELECT byte_length FROM session_segments ORDER BY segment_id");
            using var reader = command.ExecuteReader();
            var result = new List<int>();
            while (reader.Read())
                result.Add(reader.GetInt32(0));
            return result;
        });
        Assert.True(sizes.Count >= 3, string.Join(",", sizes));
        foreach (var size in sizes.SkipLast(1))
            Assert.InRange(size, SessionSegmentPlanner.PieceBytes, SessionSegmentPlanner.PieceBytes + 45 * 1024);
        Assert.Equal(37, (await Open().LoadAsync("s"))!.History.Count);
    }

    [Fact]
    public async Task A_cancelled_compaction_leaves_nothing_behind()
    {
        var store = Open();
        var history = await Append(store, SessionHistory.Empty, Message(1, "one"));
        history = await Append(store, history, Message(2, "two"));
        var before = fixture.Dump();
        using var cancel = new CancellationTokenSource();
        fixture.BeforeNextCommit(cancel.Cancel);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            store.CommitCompactionAsync(
                Snapshot("s", SessionHistory.FromMessages([history[1]]), 3, version: 1),
                [Block(1).Record("s")],
                [],
                cancel.Token
            )
        );
        Assert.Equal(before, fixture.Dump());
        await store.CommitCompactionAsync(
            Snapshot("s", SessionHistory.FromMessages([history[1]]), 3, version: 1),
            [Block(1).Record("s")],
            []
        );
        Assert.Equal(["two"], Texts((await Open().LoadAsync("s"))!.History));
        Assert.Equal(1, fixture.Count("archive_blocks"));
    }

    [Fact]
    public async Task A_head_changed_behind_a_store_fails_closed_and_the_next_commit_rewrites_it()
    {
        var owner = Open();
        var history = await Append(owner, SessionHistory.Empty, Message(1, "one"));
        // Another store without a known head replaces the stored value completely.
        var other = Open();
        await other.CommitAsync(Snapshot("s", History(Message(1, "other")), 2), SaveKind.Strict);
        Assert.Equal(1, fixture.Count("session_segments"));

        await Assert.ThrowsAsync<SessionHeadChangedException>(() =>
            owner.CommitAsync(Snapshot("s", history, 2) with { Busy = true, BusyStartedAt = 1 }, SaveKind.Strict)
        );
        Assert.Equal(["other"], Texts((await Open().LoadAsync("s"))!.History));
        await owner.CommitAsync(Snapshot("s", history, 2), SaveKind.Strict);
        Assert.Equal(["one"], Texts((await Open().LoadAsync("s"))!.History));
        Assert.Equal(1, fixture.Count("session_segments"));
    }

    [Fact]
    public async Task Identity_moves_replace_the_target_and_deletion_removes_every_row()
    {
        var store = Open("old");
        await store.CommitAsync(Snapshot("old", History(Message(1, "one")), 2) with { AuthorityEnvelope = Memory(5000) }, SaveKind.Strict);
        await Open("new").CommitAsync(Snapshot("new", History(Message(1, "stale"), Message(2, "stale")), 3), SaveKind.Strict);
        Backend.MoveIdentity("old", "new");
        Assert.False(Backend.Exists("old"));
        Assert.Equal(["one"], Texts((await Open("new").LoadAsync("new"))!.History));
        Assert.Equal(1, fixture.Count("session_heads"));
        Assert.Equal(1, fixture.Count("session_segments"));

        var stages = new List<string>();
        Backend.DeleteAuthority("new", () => stages.Add("removed"));
        Assert.Equal(["removed"], stages);
        Assert.Equal(0, fixture.Count("session_heads"));
        Assert.Equal(0, fixture.Count("session_segments"));
        Assert.Equal(0, fixture.Count("session_envelope_parts"));
    }

    [Fact]
    public async Task A_missing_segment_makes_the_authority_unavailable()
    {
        await Append(Open(), SessionHistory.Empty, Message(1, "one"));
        fixture.Tenant.Write(tx => tx.Execute("DELETE FROM session_segments"));
        await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() => Open().LoadAsync("s"));
    }
}
