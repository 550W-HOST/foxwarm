using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorMainCallerTests
{
    private static async Task<JsonObject> Recall(
        SessionManager manager,
        SessionOwner owner,
        JsonObject args
    )
    {
        var workspace = manager.IdentityWorkspace(owner)!.ToolDirectory;
        await using var mcp = new Foxwarm.McpClient(Path.Combine(workspace, ".vector-test-mcp"));
        var registry = SessionToolExecutor.CreateRegistry(
            new JsonArray(ArchiveRecallTool.Definition()),
            mcp,
            _ => workspace
        );
        var tools = new SessionToolExecutor(
            new WorkspaceTools(workspace),
            owner,
            manager,
            registry
        );
        tools.BeginTurn();
        return (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["name"] = "recall",
                    ["args"] = args,
                },
                default
            )
        )!.AsObject();
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) =>
            throw new InvalidOperationException(
                "No model request belongs to an authority callback test."
            );
    }

    [Fact]
    public async Task Authority_commit_notification_ignores_precommit_staging_and_survives_post_rename_failure()
    {
        using var temp = new TempDirectory();
        AtomicJsonWriteStage? fault = null;
        var notified = new List<long>();
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "commit-index",
            "main",
            stage =>
            {
                if (fault == stage)
                {
                    fault = null;
                    throw new IOException("synthetic publication failure");
                }
            },
            archiveCommitted: (snapshot, _, _) =>
            {
                notified.Add(snapshot.NextMessageSeq - 1);
                throw new IOException("derivative failure must not change commit success");
            }
        );
        var registry = new SessionRegistry(store, new NoChat());
        var entry = registry.Add("commit-index");
        await entry.SaveLane.SaveStrictAsync();
        Task Append(string text) =>
            entry.SaveLane.CommitCanonicalAppendAsync(state =>
            {
                var seq = state.NextMessageSeq;
                var row = VectorFixture.Message(text);
                row["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 };
                var snapshot = state.Snapshot();
                return new CanonicalAppendPreparation(
                    snapshot with
                    {
                        History = snapshot.History.AppendJson([row]),
                        NextMessageSeq = seq + 1,
                    },
                    [row],
                    live =>
                    {
                        live.History.Add(row);
                        live.NextMessageSeq = seq + 1;
                    }
                );
            });
        fault = AtomicJsonWriteStage.BeforeRename;
        await Assert.ThrowsAsync<IOException>(() => Append("uncommitted"));
        Assert.Empty(notified);
        Assert.Empty(store.Archive.ReadMessages());
        fault = AtomicJsonWriteStage.AfterRenameBeforeDirectorySync;
        await Assert.ThrowsAsync<AuthorityCommittedException>(() => Append("published"));
        Assert.Equal(new long[] { 1 }, notified);
        Assert.Single(store.Archive.ReadMessages());
        await Append("ordinary success");
        Assert.Equal(new long[] { 1, 2 }, notified);
    }

    [Fact]
    public async Task Real_Main_committed_append_starts_indexing_at_the_Source_message_threshold()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        var owner = await manager.CreateNamedAsync("main", "commit-index", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            Enumerable
                .Range(1, 50)
                .Select(index => VectorFixture.Message("violet committed " + index))
                .ToArray()
        );
        await VectorStorageTests.UntilAsync(() =>
            owner.Archive.VectorCheckpoint().RawLastIndexedSeq == 50
        );
        Assert.NotEmpty(f.Peer.Requests);
        Assert.Equal(50, owner.Archive.ReadMessages().Count);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Force_waits_for_its_queued_committed_target_and_publishes_compatibility_only_on_success(
        bool child,
        bool failTarget
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync(child);
        await manager.Vector.WaitForStartupAsync();
        var owner = await manager.CreateNamedAsync("main", "queued-force", null, null);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var requests = 0;
        f.Peer.BeforeResponse = async input =>
        {
            if (Interlocked.Increment(ref requests) == 1)
            {
                entered.TrySetResult();
                await release.Task;
            }
            if (failTarget && input.Contains("queued suffix", StringComparison.Ordinal))
                f.Peer.Fail = true;
        };
        try
        {
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                VectorFixture.Message(new string('a', 25000))
            );
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                VectorFixture.Message("violet queued suffix")
            );
            var forced = manager.ForceVectorIndexAsync(owner);
            // FIFO dispatch makes this a transport barrier without releasing the held background run.
            Assert.Equal(
                2,
                VectorRuntime.Integer(
                    (await manager.Vector.StatusAsync(owner.Id))["latestLocalMessageSeq"]
                )
            );
            release.TrySetResult();
            if (failTarget)
            {
                await Assert.ThrowsAsync<HttpRequestException>(() =>
                    forced.WaitAsync(TimeSpan.FromSeconds(10))
                );
                Assert.Equal(1, owner.Archive.VectorCheckpoint().RawLastIndexedSeq);
                Assert.Equal(
                    0,
                    VectorRuntime.Integer(
                        owner.Entry.Snapshot().AuthorityEnvelope["vectorIndexPosition"]
                    )
                );
            }
            else
            {
                Assert.Equal(2, await forced.WaitAsync(TimeSpan.FromSeconds(10)));
                var status = await manager.Vector.StatusAsync(owner.Id);
                Assert.Equal(2, VectorRuntime.Integer(status["lastIndexedSeq"]));
                Assert.Equal(0, VectorRuntime.Integer(status["pendingMessageCount"]));
                Assert.Equal(
                    2,
                    VectorRuntime.Integer(
                        owner.Entry.Snapshot().AuthorityEnvelope["vectorIndexPosition"]
                    )
                );
            }
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Current_agent_model_recall_retains_never_moved_deleted_Archive_sources()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        var source = await manager.CreateNamedAsync("main", "retained", null, null);
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            source,
            VectorFixture.Message("violet retained authority marker")
        );
        await manager.ForceVectorIndexAsync(source);
        await manager.DeleteAsync(source.Id);
        Assert.Null(manager.Catalog.Get(source.Id));
        Assert.Single(manager.ArchiveReader(source.Id).ReadMessages());
        var result = await Recall(
            manager,
            caller,
            new() { ["vector_query"] = "violet", ["scope"] = "current-agent" }
        );
        Assert.Contains("retained authority marker", result.ToJsonString());
    }

    [Fact]
    public void Query_notices_remain_separate_from_selected_source_notices_and_precede_the_title()
    {
        var renderer = new ContextPreviewRenderer(new() { ["excludeRegex"] = "excluded" });
        var items = new PreviewItem[]
        {
            new("selected", "selected body", "selected", null, ["SelectedSourceNotice"]),
            new("limited", "limited body", "limited", null, ["LimitedSourceNotice"]),
            new("excluded", "excluded body", "excluded", null, ["ExcludedSourceNotice"]),
        };
        var output = renderer.RenderItems(
            items,
            "",
            _ => "TitleMarker",
            "EmptyMarker",
            ["QueryNotice"],
            maxItems: 1
        );
        Assert.Contains("QueryNotice", output);
        Assert.Contains("SelectedSourceNotice", output);
        Assert.DoesNotContain("LimitedSourceNotice", output);
        Assert.DoesNotContain("ExcludedSourceNotice", output);
        Assert.True(
            output.IndexOf("QueryNotice", StringComparison.Ordinal)
                < output.IndexOf("SelectedSourceNotice", StringComparison.Ordinal)
        );
        Assert.True(
            output.IndexOf("SelectedSourceNotice", StringComparison.Ordinal)
                < output.IndexOf("TitleMarker", StringComparison.Ordinal)
        );
        var empty = renderer.RenderItems(
            items,
            "",
            _ => "TitleMarker",
            "EmptyMarker",
            ["QueryNotice"],
            maxItems: 0
        );
        Assert.Contains("QueryNotice", empty);
        Assert.DoesNotContain("SelectedSourceNotice", empty);
    }

    [Fact]
    public async Task Source_window_notices_follow_final_filtered_and_result_limited_groups()
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync();
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        foreach (var count in new[] { 25, 35 })
        {
            var source = await manager.CreateNamedAsync("main", "notice-" + count, null, null);
            await ForkClearLifecycleTests.AppendAsync(
                source,
                Enumerable
                    .Range(1, count)
                    .Select(seq =>
                        VectorFixture.Message(
                            seq == 1 ? "violet literalneedle"
                            : seq == count ? "violet includeneedle"
                            : "violet surrounding context"
                        )
                    )
                    .ToArray()
            );
            await manager.ForceVectorIndexAsync(source);
        }
        var args = new JsonObject
        {
            ["vector_query"] = "violet",
            ["scope"] = "current-agent",
            ["contentFilter"] = "literalneedle",
            ["includeRegex"] = "includeneedle",
            ["previewLength"] = 20000,
        };
        var all = (await Recall(manager, caller, (JsonObject)args.DeepClone()))[
            "output"
        ]!.GetValue<string>();
        Assert.Contains("`msg#25`", all);
        Assert.Contains("`msg#35`", all);
        args["excludeRegex"] = "violet";
        var excluded = (await Recall(manager, caller, (JsonObject)args.DeepClone()))[
            "output"
        ]!.GetValue<string>();
        Assert.DoesNotContain("`msg#25`", excluded);
        Assert.DoesNotContain("`msg#35`", excluded);
        args.Remove("excludeRegex");
        args["limit"] = 1;
        var limited = (await Recall(manager, caller, (JsonObject)args.DeepClone()))[
            "output"
        ]!.GetValue<string>();
        var selectedFirst = limited.Contains("session:notice-25;", StringComparison.Ordinal);
        Assert.Contains(selectedFirst ? "`msg#25`" : "`msg#35`", limited);
        Assert.DoesNotContain(selectedFirst ? "`msg#35`" : "`msg#25`", limited);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Canonical_scope_fence_blocks_supported_cross_agent_move_leak_and_keeps_captured_lineage_and_admin_scope(
        bool child
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        await using var manager = await f.ManagerAsync(child, lexical: true);
        await manager.CreateAgentAsync("origin", false);
        await manager.CreateAgentAsync("destination", false);
        var source = await manager.CreateNamedAsync("origin", "source", null, null);
        var caller = await manager.CreateNamedAsync("origin", "caller", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            source,
            VectorFixture.Message("violet transferred authority marker")
        );
        await manager.ForceVectorIndexAsync(source);
        var before = await Recall(
            manager,
            caller,
            new() { ["vector_query"] = "violet", ["scope"] = "current-agent" }
        );
        Assert.Contains("transferred authority marker", before.ToJsonString());
        await manager.MoveIdentityAsync(
            caller,
            new JsonObject { ["sessionId"] = source.Id, ["newSessionId"] = "same-agent" }
        );
        Assert.Contains(
            "transferred authority marker",
            (
                await Recall(
                    manager,
                    caller,
                    new() { ["vector_query"] = "violet", ["scope"] = "current-agent" }
                )
            ).ToJsonString()
        );
        var fork = await manager.ForkAsync(source, "captured");
        var oldId = source.Id;
        await manager.MoveIdentityAsync(
            caller,
            new JsonObject
            {
                ["sessionId"] = source.Id,
                ["newAgentName"] = "destination",
                ["newSessionId"] = "moved",
            }
        );
        Assert.Equal("destination/moved", source.Id);
        Assert.Equal(source.Id, manager.ArchiveReader(oldId).CanonicalSessionId);
        var after = await Recall(
            manager,
            caller,
            new() { ["vector_query"] = "violet", ["scope"] = "current-agent" }
        );
        Assert.DoesNotContain("transferred authority marker", after.ToJsonString());
        var denied = await Recall(
            manager,
            caller,
            new() { ["vector_query"] = "violet", ["sessionId"] = source.Id }
        );
        Assert.NotNull(denied["error"]);
        var inherited = await Recall(
            manager,
            fork,
            new() { ["vector_query"] = "violet", ["scope"] = "current-session" }
        );
        Assert.Contains("transferred authority marker", inherited.ToJsonString());
        var authorized = manager.ResolveVectorScope(caller, new() { ["scope"] = "current-agent" });
        var rejectedBeforeReload = await VectorRecall.SearchAsync(
            manager.Vector,
            _ =>
                throw new InvalidOperationException(
                    "Rejected sources must not reach Archive or stored-text fallback."
                ),
            "violet",
            5,
            authorized.Options,
            authorized.Scope,
            authorized.SessionId,
            sourceAllowed: id => manager.VectorCanonicalSourceAllowed(id, authorized.Options)
        );
        Assert.Empty(rejectedBeforeReload.Items);
        var admin = await manager.SearchVectorHistoryAsync("violet", 5, null, null);
        Assert.Contains("transferred authority marker", admin.ToJsonString());
        var exact = await Recall(
            manager,
            caller,
            new() { ["sessionId"] = source.Id, ["target"] = "msg#1" }
        );
        Assert.Contains("transferred authority marker", exact.ToJsonString());
        Assert.DoesNotContain(
            (await manager.Vector.SearchAsync("violet", 5, new(Agent: "destination"))).Hits,
            hit => hit["kind"]!.GetValue<string>() == "raw"
        );
        await manager.DeleteAsync(source.Id);
        Assert.Null(manager.Catalog.Get(source.Id));
        Assert.Equal(source.Id, manager.ArchiveReader(oldId).CanonicalSessionId);
        Assert.False(manager.VectorCanonicalSourceAllowed(oldId, authorized.Options));
        Assert.DoesNotContain(
            "transferred authority marker",
            (
                await Recall(
                    manager,
                    caller,
                    new() { ["vector_query"] = "violet", ["scope"] = "current-agent" }
                )
            ).ToJsonString()
        );
        Assert.Empty(
            (
                await VectorRecall.SearchAsync(
                    manager.Vector,
                    _ =>
                        throw new InvalidOperationException(
                            "Deleted foreign sources must not reach fallback."
                        ),
                    "violet",
                    5,
                    authorized.Options,
                    authorized.Scope,
                    authorized.SessionId,
                    sourceAllowed: id =>
                        manager.VectorCanonicalSourceAllowed(id, authorized.Options)
                )
            ).Items
        );
        Assert.Contains(
            "transferred authority marker",
            (
                await Recall(
                    manager,
                    fork,
                    new() { ["vector_query"] = "violet", ["scope"] = "current-session" }
                )
            ).ToJsonString()
        );
    }

    [Fact]
    public async Task Real_Main_HTTP_history_search_is_admin_only_returns_bounded_authoritative_windows_and_runs_force_command()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "http-vector";
        await using (var seed = await f.ManagerAsync(lexical: true))
        {
            var owner = await seed.CreateNamedAsync("main", id, null, null);
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                Enumerable
                    .Range(1, 40)
                    .Select(index => VectorFixture.Message("violet historical context " + index))
                    .ToArray()
            );
            await seed.Vector.ForceAsync(owner.Id, 40, 0);
        }
        var file = Path.Combine(f.Data, "state", "config.yaml");
        var config = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        config["access"] = new JsonObject
        {
            ["identities"] = new JsonObject
            {
                ["scoped"] = new JsonObject
                {
                    ["token"] = "synthetic-scoped-vector",
                    ["surfaces"] = new JsonObject
                    {
                        ["webui"] = new JsonObject { ["sessions"] = new JsonArray(id) },
                    },
                },
            },
        };
        await File.WriteAllTextAsync(file, config.ToJsonString());
        var settings = await HttpServerSettings.CaptureDesktopAsync(f.Data);
        await using var host = await MainHost.CreateAsync(
            [],
            f.Data,
            f.Work,
            new ModelConfiguration(f.Data),
            settings,
            null
        );
        await host.App.StartAsync();
        using var admin = new HttpClient { BaseAddress = new(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var response = await admin.GetAsync(
            "api/history/search?query=violet&limit=1&sessionId=" + id
        );
        response.EnsureSuccessStatusCode();
        var result = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        var first = Assert.Single(result["results"]!.AsArray())!.AsObject();
        Assert.InRange(first["messages"]!.AsArray().Count, 1, 16);
        Assert.True(first["hasLater"]!.GetValue<bool>());
        Assert.Equal(40, first["sourceRange"]!["endSeq"]!.GetValue<int>());
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-scoped-vector");
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await scoped.GetAsync("api/history/search?query=violet")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("api/history/search?query=violet&limit=21")).StatusCode
        );
        var authority = Path.Combine(f.Data, "state", "sessions", id + ".json");
        Assert.Equal(
            0,
            VectorRuntime.Integer(
                JsonNode.Parse(await File.ReadAllTextAsync(authority))!["vectorIndexPosition"]
            )
        );
        var indexed = await admin.PostAsJsonAsync(
            "api/sessions/" + id + "/message",
            new { text = "/session index" }
        );
        indexed.EnsureSuccessStatusCode();
        await VectorStorageTests.UntilAsync(() =>
            VectorRuntime.Integer(
                JsonNode.Parse(File.ReadAllText(authority))!["vectorIndexPosition"]
            ) == 40
        );
    }
}
