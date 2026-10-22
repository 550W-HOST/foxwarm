using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ForkClearLifecycleTests
{
    [Fact]
    public async Task Fork_copies_canonical_cut_and_closes_full_tail_batch_only_first_creating_call_gets_credit()
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        var hidden = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "hidden provenance" }),
            ["modelVisible"] = false,
        };
        var call = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                Call("creator-one", "create_child_session", "copy"),
                Call("creator-two", "create_child_session", "copy"),
                Call("effect", "exec", null)
            ),
        };
        await AppendAsync(parent, hidden, call);
        var before = parent.Entry.Snapshot();
        var notifications = new List<SessionRuntimeEvent>();
        fixture.Manager.Changed += notifications.Add;
        var (child, delivered) = await fixture.Manager.CreateChildAsync(
            parent,
            "copy",
            null,
            null,
            null,
            null,
            fork: true
        );
        Assert.False(delivered);
        var fork = child.Entry.Snapshot();
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            fork.History.Take(before.History.Count).Select(row => row.ToJsonString())
        );
        Assert.Equal(
            before.AuthorityEnvelope["promptCacheKey"]!.ToJsonString(),
            fork.AuthorityEnvelope["promptCacheKey"]!.ToJsonString()
        );
        Assert.Equal(
            before.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString(),
            fork.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString()
        );
        var responses = fork.History[before.History.Count].ToJson()["parts"]!.AsArray();
        Assert.Equal(
            "Child session created: " + child.Id,
            responses[0]!["functionResponse"]!["response"]!["output"]!.GetValue<string>()
        );
        Assert.All(
            responses.Skip(1),
            part =>
                Assert.Equal(
                    "Pending execution in parent session",
                    part!["functionResponse"]!["response"]!["output"]!.GetValue<string>()
                )
        );
        Assert.Contains("history-inherited", fork.History[before.History.Count + 1].ToJsonString());
        Assert.Contains("afterSend", fork.History[before.History.Count + 2].ToJsonString());
        Assert.Equal("user", fork.History.Materialize().Last()["role"]!.GetValue<string>());
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            parent.Entry.Snapshot().History.Select(row => row.ToJsonString())
        );
        Assert.Equal(2, child.Archive.ReadBranch()!.MessageCap);
        Assert.Equal(3, child.Archive.ReadMessages().Count);
        // Creation appends the suffix before publishing the owner; initial history is snapshot-only.
        Assert.DoesNotContain(notifications, value => value.Kind == SessionEventKind.MessageCommitted);
        var manual = await fixture.Manager.ForkAsync(parent, "copy");
        Assert.All(
            manual.Entry.Snapshot().History[before.History.Count].ToJson()["parts"]!.AsArray(),
            part =>
                Assert.Equal(
                    "Pending execution in parent session",
                    part!["functionResponse"]!["response"]!["output"]!.GetValue<string>()
                )
        );
        Assert.Equal(3, manual.Archive.ReadMessages().Count);
    }

    [Fact]
    public async Task Manual_command_keeps_parent_lineage_but_initial_instructions_use_user_ingress_while_delegated_children_keep_handoff()
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        parent.Registry.TriggerOverride = _ => Task.CompletedTask;
        fixture.Manager.TopologyChanged += () =>
        {
            foreach (var owner in fixture.Manager.Owners())
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        await AppendAsync(
            parent,
            Text("inherited input"),
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "real inherited reply" }),
            }
        );
        var before = parent.Entry.Snapshot();
        var runtime = new SessionRuntime(fixture.Manager);
        var notifications = new List<SessionRuntimeEvent>();
        parent.Changed += notifications.Add;
        var initial = "Ordinary user instructions.\nSecond line.\n";
        var manual = await runtime.ForkCommandAsync(parent.Id, "manual", initial);
        var snapshot = manual.Entry.Snapshot();
        Assert.Equal(SessionIdentity.Build(parent.Agent, "manual"), manual.Id);
        Assert.Equal(parent.Id, snapshot.AuthorityEnvelope["parentSessionId"]!.GetValue<string>());
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            snapshot.History.Take(before.History.Count).Select(row => row.ToJsonString())
        );
        Assert.Equal(
            new[] { "user", "user" },
            snapshot
                .History.Materialize()
                .Skip(before.History.Count)
                .Select(row => row["role"]!.GetValue<string>())
        );
        Assert.Null(snapshot.AuthorityEnvelope["childHandoffState"]);
        var input = Assert.Single(snapshot.Queue);
        Assert.Equal(QueueItemType.User, input.Type);
        Assert.Equal(initial, Assert.Single(input.Parts!)["text"]!.GetValue<string>());
        Assert.Null(input.SourceSessionId);
        Assert.Contains(
            "manual-fork-created",
            parent.Entry.Snapshot().History.Last().ToJsonString()
        );
        var parentNotice = Assert.Single(notifications, value => value.Kind == SessionEventKind.MessageCommitted);
        Assert.True(JsonNode.DeepEquals(parent.History().Last(), parentNotice.Data));
        var (delegated, delivered) = await fixture.Manager.CreateChildAsync(
            parent,
            "delegated",
            null,
            null,
            initial,
            null,
            fork: true
        );
        Assert.True(delivered);
        Assert.Equal(
            QueueItemType.Intersession,
            Assert.Single(delegated.Entry.Snapshot().Queue).Type
        );
        Assert.Equal(parent.Id, Assert.Single(delegated.Entry.Snapshot().Queue).SourceSessionId);
        Assert.Equal(
            "user",
            delegated.Entry.Snapshot().History.Materialize().Last()["role"]!.GetValue<string>()
        );
        Assert.Contains("afterSend", delegated.Entry.Snapshot().History.Last().ToJsonString());
        var created = await fixture.Manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "linked fork" },
            parent.Id
        );
        var taskId = created.Payload["task"]!["id"]!.GetValue<string>();
        var attached = await fixture.Manager.Tasks.CreateAttachedChildAsync(
            taskId,
            parent.Id,
            async () =>
                (
                    await fixture.Manager.CreateChildAsync(
                        parent,
                        "linked",
                        null,
                        null,
                        null,
                        null,
                        fork: true,
                        taskId: taskId
                    )
                ).Child,
            "Assigned instructions"
        );
        Assert.True(attached.AssignmentDelivered);
        var linked = attached.Child.Entry.Snapshot();
        Assert.Equal(
            new[] { "user", "user" },
            linked
                .History.Materialize()
                .Skip(parent.Entry.Snapshot().History.Count)
                .Select(row => row["role"]!.GetValue<string>())
        );
        Assert.Contains(taskId, linked.History.Last().ToJsonString());
        Assert.DoesNotContain("send_to_session(", linked.History.Last().ToJsonString());
        Assert.Contains(taskId, Assert.Single(linked.Queue).Parts![0].ToJsonString());
    }

    [Fact]
    public async Task Idle_clear_retains_immutable_lifetime_sequence_and_repairs_only_owned_effective_block_frontier()
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        await AppendAsync(parent, Text("old dialogue"));
        parent.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                parent.Id,
                "main",
                7,
                1,
                "message",
                1,
                1,
                null,
                1,
                1,
                1000,
                1000,
                "Old lifetime block",
                null,
                1000
            ),
        ]);
        var before = parent.Entry.Snapshot();
        var raw = parent.Archive.ReadMessages()[0].MessageJson;
        var block = parent.Archive.ReadBlocksRange(7, 7).Single()!;
        var result = await fixture.Manager.ClearAsync(parent);
        var empty = parent.Entry.Snapshot();
        Assert.True(result.Cleared);
        Assert.False(result.RequiresRetry);
        Assert.Empty(empty.History);
        Assert.Equal(before.NextMessageSeq, empty.NextMessageSeq);
        Assert.Equal(8, empty.AuthorityEnvelope["nextBlockId"]!.GetValue<long>());
        Assert.NotEqual(
            before.AuthorityEnvelope["promptCacheKey"]!.ToJsonString(),
            empty.AuthorityEnvelope["promptCacheKey"]!.ToJsonString()
        );
        Assert.Equal(raw, parent.Archive.ReadMessages()[0].MessageJson);
        Assert.Equal(block, parent.Archive.ReadBlocksRange(7, 7).Single());
        var child = await fixture.Manager.ForkAsync(parent, "after-clear");
        Assert.Equal(7, child.Archive.ReadBranch()!.BlockCap);
        Assert.Equal(1, child.Archive.ReadBranch()!.MessageCap);
        Assert.Equal(block, new ArchiveContextReader(child.Archive).Block(7));
        Assert.DoesNotContain(
            child.Entry.Snapshot().History,
            row => row.ToJsonString().Contains("old dialogue", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Fork_resolves_target_frontier_without_writing_parent_counter_and_zero_caps_stay_zero()
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        await AppendAsync(parent, Text("old prefix"));
        parent.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                parent.Id,
                "main",
                7,
                1,
                "message",
                1,
                1,
                null,
                1,
                1,
                1000,
                1000,
                "Known lifetime block",
                null,
                1000
            ),
        ]);
        var parentPath = Path.Combine(fixture.Data, "state", "sessions", parent.Id + ".json");
        var bytes = await File.ReadAllTextAsync(parentPath);
        var sourceCounter = parent
            .Entry.Snapshot()
            .AuthorityEnvelope["nextBlockId"]
            ?.ToJsonString();
        var child = await fixture.Manager.ForkAsync(parent, "pure-frontier");
        Assert.Equal(8, child.Entry.Snapshot().AuthorityEnvelope["nextBlockId"]!.GetValue<long>());
        Assert.Equal(7, child.Archive.ReadBranch()!.BlockCap);
        Assert.Equal(bytes, await File.ReadAllTextAsync(parentPath));
        Assert.Equal(
            sourceCounter,
            parent.Entry.Snapshot().AuthorityEnvelope["nextBlockId"]?.ToJsonString()
        );
        var zero = new SqliteArchiveMessageStore(fixture.Database, "zero-cap");
        zero.Initialize();
        zero.EnsureBranch(parent.Id, 0, 0);
        parent.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                parent.Id,
                "main",
                8,
                1,
                "message",
                1,
                1,
                null,
                1,
                1,
                1000,
                1000,
                "Later block",
                null,
                2000
            ),
        ]);
        Assert.Equal(7, child.Archive.EffectiveBlockHighWater());
        Assert.Equal(0, zero.EffectiveBlockHighWater());
        Assert.Equal(0, zero.ReadBranch()!.BlockCap);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fork_precommit_compensates_owned_sources_postrename_retains_real_partial_child(
        bool committed
    )
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        await AppendAsync(parent, Text("prefix"));
        var id = parent.Id + "_fault";
        fixture.Fault(id, "create", committed);
        if (committed)
        {
            var error = await Assert.ThrowsAsync<CommittedSessionCreationException>(() =>
                fixture.Manager.ForkAsync(parent, "fault")
            );
            Assert.Equal(id, error.SessionId);
            Assert.NotNull(fixture.Manager.Find(id));
            Assert.NotNull(fixture.Manager.Find(id)!.Archive.ReadBranch());
            var next = await fixture.Manager.ForkAsync(parent, "fault");
            Assert.Equal(id + "_2", next.Id);
        }
        else
        {
            await Assert.ThrowsAsync<IOException>(() => fixture.Manager.ForkAsync(parent, "fault"));
            Assert.Null(fixture.Manager.Find(id));
            var archive = new SqliteArchiveMessageStore(fixture.Database, id);
            Assert.Null(archive.ReadBranch());
            Assert.Empty(archive.ReadMessages());
            Assert.False(
                File.Exists(Path.Combine(fixture.Data, "state", "sessions", id + ".json"))
            );
            Assert.Equal(id, (await fixture.Manager.ForkAsync(parent, "fault")).Id);
        }
        Assert.Single(parent.Archive.ReadMessages());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Clear_failure_publication_matches_atomic_authority_boundary_without_poisoning_lane(
        bool committed
    )
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        await AppendAsync(parent, Text("retained audit"));
        var before = parent.Entry.Snapshot();
        fixture.Fault(parent.Id, "clear", committed);
        if (committed)
            await Assert.ThrowsAsync<AuthorityCommittedException>(() =>
                fixture.Manager.ClearAsync(parent)
            );
        else
            await Assert.ThrowsAsync<IOException>(() => fixture.Manager.ClearAsync(parent));
        var live = parent.Entry.Snapshot();
        Assert.False(parent.Entry.HistoryMutation);
        Assert.Equal(committed ? 0 : 1, live.History.Count);
        Assert.Equal(before.NextMessageSeq, live.NextMessageSeq);
        Assert.Equal(
            committed,
            before.AuthorityEnvelope["promptCacheKey"]!.ToJsonString()
                != live.AuthorityEnvelope["promptCacheKey"]!.ToJsonString()
        );
        Assert.Single(parent.Archive.ReadMessages());
        await parent.Entry.SaveLane.SaveStrictAsync();
        Assert.Equal(
            committed ? 0 : 1,
            JsonNode.Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(fixture.Data, "state", "sessions", parent.Id + ".json")
                )
            )!["history"]!
                .AsArray()
                .Count
        );
    }

    [Fact]
    public async Task Known_failed_branch_cleanup_keeps_reserved_id_without_claiming_an_uncommitted_child()
    {
        await using var fixture = new LifecycleFixture();
        var parent = await fixture.Manager.CreateNamedAsync("main", "main", null, null);
        await AppendAsync(parent, Text("parent audit"));
        var id = parent.Id + "_residue";
        fixture.Fault(id, "create", false);
        await File.WriteAllTextAsync(
            Path.Combine(
                fixture.Data,
                "state",
                "experiment-faults",
                SessionIdentity.ExecDirectorySegment(id) + ".create-cleanup-fail"
            ),
            "once"
        );
        await Assert.ThrowsAsync<AggregateException>(() =>
            fixture.Manager.ForkAsync(parent, "residue")
        );
        Assert.Null(fixture.Manager.Find(id));
        var archive = new SqliteArchiveMessageStore(fixture.Database, id);
        Assert.NotNull(archive.ReadBranch());
        Assert.Empty(archive.ReadMessages());
        Assert.Single(parent.Archive.ReadMessages());
        Assert.Equal(id + "_2", (await fixture.Manager.ForkAsync(parent, "residue")).Id);
    }

    [Fact]
    public async Task First_creation_adds_branch_schema_to_an_empty_predecessor_archive()
    {
        await using var fixture = new LifecycleFixture(database =>
        {
            new SqliteArchiveMessageStore(database, "fixture").Initialize();
            // Establish the predecessor before the Main data-root writer starts.
            using var connection = new Microsoft.Data.Sqlite.SqliteConnection(
                "Data Source=" + database
            );
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "DROP TABLE archive_branches";
            command.ExecuteNonQuery();
        });
        var owner = await fixture.Manager.CreateAsync();
        Assert.Empty(owner.Archive.ReadMessages());
        Assert.NotNull(owner.Archive.ReadBranch());
        Assert.NotNull(
            await new PersistentSessionAuthorityStore(fixture.Data, owner.Id).LoadAsync(owner.Id)
        );
    }

    private static JsonObject Text(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static JsonObject Call(string id, string name, string? suffix) =>
        new()
        {
            ["functionCall"] = new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = suffix is null
                    ? new JsonObject()
                    : new JsonObject { ["suffix"] = suffix },
            },
        };

    internal static Task AppendAsync(SessionOwner owner, params JsonObject[] supplied) =>
        owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
        {
            var seq = state.NextMessageSeq;
            var rows = supplied
                .Select(row =>
                {
                    var copy = (JsonObject)row.DeepClone();
                    copy["__meta"] = new JsonObject { ["seq"] = seq++, ["timestamp"] = 1000 };
                    return copy;
                })
                .ToArray();
            var snapshot = state.Snapshot();
            var meta = (JsonObject)snapshot.Meta.DeepClone();
            meta["messageCount"] = snapshot.History.Count + rows.Length;
            return new CanonicalAppendPreparation(
                snapshot with
                {
                    History = snapshot.History.AppendJson(rows),
                    NextMessageSeq = seq,
                    Meta = meta,
                },
                rows,
                live =>
                {
                    live.History.AddRange(rows);
                    live.NextMessageSeq = seq;
                    live.Meta["messageCount"] = live.History.Count;
                }
            );
        });

    private sealed class LifecycleFixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        internal readonly string Data,
            Database;
        internal readonly SessionManager Manager;

        internal LifecycleFixture(Action<string>? prepareArchive = null)
        {
            Data = Path.Combine(temp.Path, "data");
            Database = Path.Combine(Data, "state", "archive-store.sqlite");
            prepareArchive?.Invoke(Database);
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a/wire",
                "",
                "",
                713
            );
            Manager = new SessionManager(
                Data,
                work,
                options,
                HostModels.ForTest(options),
                Path.Combine(temp.Path, "skills")
            );
        }

        internal void Fault(string id, string action, bool committed)
        {
            var folder = Path.Combine(Data, "state", "experiment-faults");
            Directory.CreateDirectory(folder);
            File.WriteAllText(
                Path.Combine(
                    folder,
                    SessionIdentity.ExecDirectorySegment(id)
                        + "."
                        + action
                        + (committed ? "-after-rename" : "-before-rename")
                ),
                "once"
            );
        }

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            temp.Dispose();
        }
    }
}
