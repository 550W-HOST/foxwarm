using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class CompactLifecycleTests
{
    [Fact]
    public void Compact_plan_schema_allows_direct_or_repaired_file_submission()
    {
        var definition = CompactPrompt.ToolDefinition();
        var parameters = definition["parameters"]!.AsObject();
        var properties = parameters["properties"]!.AsObject();
        Assert.Equal("string", properties["argsFilePath"]!["type"]!.GetValue<string>());
        Assert.Null(parameters["required"]);
        Assert.NotNull(properties["replaceAsBlocks"]);
    }

    [Fact]
    public async Task Real_main_compaction_repairs_raw_arguments_in_one_owned_operation_and_commits_the_plan()
    {
        var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        SessionManager? managerForPeer = null;
        var policyPath = Path.Combine(data, "state", "tool-authorization.yaml");
        await using var peer = new ScriptedResponsesSequenceServer(
            9,
            async (index, stream, captured) =>
            {
                var texts = JsonNode.Parse(captured.Body)!["input"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? [])
                    .Select(row => SessionWait.Text(row["text"]) ?? "")
                    .ToArray();
                var all = string.Join("\n", texts);
                var match = Regex.Matches(
                    all,
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                var start = long.Parse(match[0].Groups[1].Value);
                var last = match[^1];
                var end = long.Parse(
                    last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                );
                var validBlocks = new JsonArray(
                    new JsonObject
                    {
                        ["level"] = 1,
                        ["sourceKind"] = "message",
                        ["sourceStart"] = start,
                        ["sourceEnd"] = end,
                        ["summary"] = "Repaired compact plan.",
                    }
                );
                var path =
                    index <= 1
                        ? null
                        : Directory
                            .EnumerateFiles(
                                Path.Combine(work, ".temp"),
                                "plan.json",
                                SearchOption.AllDirectories
                            )
                            .Single();
                JsonObject call;
                if (index == 0)
                    call = FunctionCall(
                        "no-pending-file",
                        "submit_compact_plan",
                        new JsonObject { ["argsFilePath"] = "/tmp/no-pending-compact-plan.json" }
                    );
                else if (index == 1)
                    call = FunctionCall(
                        "malformed",
                        "submit_compact_plan",
                        new JsonObject(),
                        raw: "{\"replaceAsBlocks\":"
                    );
                else if (index == 2)
                    call = FunctionCall(
                        "bad-file-submit",
                        "submit_compact_plan",
                        new JsonObject { ["argsFilePath"] = path! }
                    );
                else if (index == 3)
                    call = FunctionCall(
                        "cancel-all",
                        "edit",
                        new JsonObject
                        {
                            ["filePath"] = path!,
                            ["oldText"] = "{\"replaceAsBlocks\":",
                            ["newText"] = "ignored",
                            ["__cancelAllToolsThisTurn"] = true,
                        }
                    );
                else if (index == 4)
                    call = FunctionCall(
                        "false-control",
                        "edit",
                        new JsonObject
                        {
                            ["filePath"] = path!,
                            ["oldText"] = "{\"replaceAsBlocks\":",
                            ["newText"] = "ignored",
                            ["__cancelTool"] = false,
                        }
                    );
                else if (index == 5)
                    call = FunctionCall(
                        "deny-edit",
                        "edit",
                        new JsonObject
                        {
                            ["filePath"] = path!,
                            ["oldText"] = "{\"replaceAsBlocks\":",
                            ["newText"] = "ignored",
                        }
                    );
                else if (index == 6)
                    call = FunctionCall(
                        "failed-hunk",
                        "apply_patch",
                        new JsonObject
                        {
                            ["input"] = "*** Begin Patch\n*** Update File: " + path
                                + "\n@@ repair-target\n-old-content-not-in-file\n+required-added-line-tail\n*** End Patch",
                        }
                    );
                else if (index == 7)
                {
                    // Matching the original raw arguments proves the failed hunk left the held file unchanged.
                    var patch =
                        "*** Begin Patch\n*** Update File: "
                        + path
                        + "\n-{\"replaceAsBlocks\":\n+{\"replaceAsBlocks\":"
                        + validBlocks.ToJsonString()
                        + "}\n*** End Patch";
                    call = FunctionCall(
                        "repair-after-deny",
                        "apply_patch",
                        new JsonObject { ["input"] = patch }
                    );
                }
                else
                    call = FunctionCall(
                        "submit",
                        "submit_compact_plan",
                        new JsonObject { ["argsFilePath"] = path! }
                    );
                if (index == 5)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(policyPath)!);
                    await File.WriteAllTextAsync(
                        policyPath,
                        "version: 1\nrules: [{id: deny-edit, action: deny, match: {tool: {source: node, name: edit}}}]\n"
                    );
                    managerForPeer!.Authorization.Invalidate();
                }
                else if (index == 6)
                {
                    File.Delete(policyPath);
                    managerForPeer!.Authorization.Invalidate();
                }
                var output = new JsonArray(call);
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "compact-repair",
                        ["output"] = output,
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
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        var models = HostModels.ForTest(options);
        await using var manager = new SessionManager(
            data,
            work,
            options,
            models,
            Path.Combine(AppContext.BaseDirectory, "skills")
        );
        managerForPeer = manager;
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "compact-repair", null, null);
        owner.Entry.WithState(state =>
        {
            for (var seq = 1; seq <= 8; seq++)
                state.History.Add(
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject
                            {
                                ["text"] = "context " + seq + " " + new string('x', 5000),
                            }
                        ),
                        ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
                    }
                );
            state.NextMessageSeq = 9;
            state.Meta["messageCount"] = 8;
        });
        await owner.Entry.SaveLane.SaveStrictAsync();
        var before = owner.Entry.Snapshot().History.Count;
        var admission = await owner.Compactor.StartManualAsync();
        Assert.True(admission.Started);
        try
        {
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        }
        catch (TimeoutException error)
        {
            throw new TimeoutException(
                $"compact drain timeout; provider requests={peer.RequestCount}",
                error
            );
        }
        await owner.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
        var journalRows = await manager.Journal.ListAsync(null, "compact-plan", null, null, 20);
        Assert.NotEmpty(journalRows);
        var compactJournal = await manager.Journal.ReconstructAsync(
            journalRows[0]!["requestId"]!.GetValue<string>()
        );
        Assert.Equal("compact-plan", compactJournal["purpose"]!.GetValue<string>());
        Assert.NotEmpty(compactJournal["attempts"]!.AsArray());
        Assert.Equal(9, peer.RequestCount);
        Assert.DoesNotContain("compact-plan-", (await peer.RequestAt(1)).Body);
        Assert.Contains(
            "This file was saved from the original provider arguments.",
            (await peer.RequestAt(2)).Body
        );
        Assert.Contains("repair file must contain valid JSON", (await peer.RequestAt(3)).Body);
        Assert.Contains("Compact repair canceled", (await peer.RequestAt(4)).Body);
        Assert.Contains("invalid_tool_control_argument", (await peer.RequestAt(6)).Body);
        Assert.Contains("Compact repair failed", (await peer.RequestAt(7)).Body);
        var failedHunkRequest = JsonNode.Parse((await peer.RequestAt(7)).Body)!;
        var failedHunkOutput = Assert.Single(
            failedHunkRequest["input"]!.AsArray().OfType<JsonObject>(),
            row => SessionWait.Text(row["type"]) == "function_call_output"
                && SessionWait.Text(row["call_id"]) == "failed-hunk"
        );
        var feedback = failedHunkOutput["output"]!.GetValue<string>();
        Assert.Contains("@@ repair-target", feedback);
        Assert.Contains("-old-content-not-in-file", feedback);
        Assert.Contains("+required-added-line-tail", feedback);
        Assert.Single(manager.Catalog.List());
        Assert.Single(owner.Archive.ReadBlocks());
        Assert.True(owner.Entry.Snapshot().History.Count < before);
        var completion = Assert.Single(
            owner.Entry.Snapshot().History,
            row => row["compaction"]?["planner"] is JsonObject
        );
        var planner = completion["compaction"]!["planner"]!.AsObject();
        Assert.Equal(9, planner["steps"]!.GetValue<int>());
        Assert.Equal(
            new[]
            {
                "submit_compact_plan",
                "submit_compact_plan",
                "submit_compact_plan",
                "edit",
                "edit",
                "edit",
                "apply_patch",
                "apply_patch",
                "submit_compact_plan",
            },
            planner["toolCalls"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        Assert.All(
            planner["messages"]!.AsArray(),
            message => Assert.Null(message?["__meta"]?["seq"])
        );
        var completionWithoutDiagnostics = (JsonObject)completion.DeepClone();
        completionWithoutDiagnostics.Remove("compaction");
        Assert.Equal(
            ImageTokenEstimate.Message(completionWithoutDiagnostics),
            ImageTokenEstimate.Message(completion)
        );
        var archivedCompletion = Assert.Single(
            owner.Archive.ReadMessages(),
            row => row.Message["compaction"]?["planner"] is JsonObject
        );
        Assert.Equal(completion.ToJsonString(), archivedCompletion.Message.ToJsonString());
        Assert.DoesNotContain(
            owner.Entry.Snapshot().History,
            row =>
                row["compaction"] is null
                && row.ToJsonString()
                    .Contains("Compact arguments file updated", StringComparison.Ordinal)
        );
        Assert.Empty(
            Directory.EnumerateDirectories(
                Path.Combine(manager.IdentityWorkspace(owner).ToolDirectory, ".temp"),
                "compact-plan-*"
            )
        );
        await manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(30));
        temp.Dispose();
    }

    [Fact]
    public async Task Real_main_compact_provider_failure_cleans_pending_repair_artifact()
    {
        var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                if (index == 0)
                {
                    var output = new JsonArray(
                        FunctionCall(
                            "invalid",
                            "submit_compact_plan",
                            new JsonObject { ["replaceAsBlocks"] = new JsonArray() },
                            "{\"replaceAsBlocks\":[]}"
                        )
                    );
                    var payload = new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "compact-failure",
                            ["output"] = output,
                        },
                    };
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                    );
                }
                else
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        400,
                        "text/plain",
                        Encoding.UTF8.GetBytes("provider failed")
                    );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        var models = HostModels.ForTest(options);
        await using var manager = new SessionManager(
            data,
            work,
            options,
            models,
            Path.Combine(AppContext.BaseDirectory, "skills")
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "compact-failure", null, null);
        owner.Entry.WithState(state =>
        {
            for (var seq = 1; seq <= 8; seq++)
                state.History.Add(
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject
                            {
                                ["text"] = "context " + seq + " " + new string('x', 5000),
                            }
                        ),
                        ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
                    }
                );
            state.NextMessageSeq = 9;
            state.Meta["messageCount"] = 8;
        });
        await owner.Entry.SaveLane.SaveStrictAsync();
        await owner.Compactor.StartManualAsync();
        await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(2, peer.RequestCount);
        Assert.Empty(
            Directory.EnumerateDirectories(
                Path.Combine(manager.IdentityWorkspace(owner).ToolDirectory, ".temp"),
                "compact-plan-*"
            )
        );
        await manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(30));
        temp.Dispose();
    }

    private static JsonObject FunctionCall(
        string id,
        string name,
        JsonObject args,
        string? raw = null
    ) =>
        new()
        {
            ["type"] = "function_call",
            ["id"] = id,
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = raw ?? args.ToJsonString(),
        };

    [Fact]
    public async Task Actual_image_history_compacts_without_payloads_and_keeps_original_Archive_and_blob_references()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        await fixture.SeedAsync(bytes);
        var image = fixture.Owner.Entry.Snapshot().History[0]["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(part => part["inlineDataRef"] is not null);
        var reference = image["inlineDataRef"]!.AsObject();
        var audit = fixture.Store.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
        Assert.DoesNotContain(Convert.ToBase64String(bytes), string.Join('\n', audit));
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync();
        await fixture.Owner.DrainForegroundAsync();
        Assert.Single(fixture.Store.Archive.ReadBlocks());
        Assert.Contains(
            fixture.Owner.Entry.Snapshot().History,
            row => row["__meta"]?["contextBlock"] is JsonObject
        );
        Assert.Equal(
            audit,
            fixture.Store.Archive.ReadMessages().Take(audit.Length).Select(row => row.MessageJson)
        );
        Assert.Equal(bytes, await fixture.Store.Images.ReadAsync(reference));
        var transport = Foxwarm
            .Images.ImageTransport.Project(fixture.Store.Archive.ReadMessages()[0].Message)!
            .ToJsonString();
        Assert.Contains("/blobs/", transport);
        Assert.DoesNotContain(Convert.ToBase64String(bytes), transport);
    }

    [Fact]
    public async Task Real_compaction_checkpoints_task_progress_from_ordinary_visible_sequences_once()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        var taskOwner = await fixture.AuthorizationManager.CreateNamedAsync(
            "main",
            "s",
            null,
            null
        );
        var created = await fixture.AuthorizationManager.Tasks.ExecuteForToolAsync(
            taskOwner,
            new JsonObject { ["action"] = "create", ["title"] = "compaction progress" }
        );
        var taskId = created["task"]!["id"]!.GetValue<string>();
        await fixture.AuthorizationManager.Tasks.ExecuteForToolAsync(
            taskOwner,
            new JsonObject { ["action"] = "claim", ["taskId"] = taskId }
        );

        await fixture.SeedAsync();
        var visible = TaskProgress.Sequences(fixture.Owner.Entry.Snapshot());
        Assert.NotEmpty(visible);
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync();
        await fixture.Owner.DrainForegroundAsync();

        using var db = new SqliteConnection(
            $"Data Source={Path.Combine(fixture.TaskDataRoot, "state", "tasks.sqlite")}"
        );
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "SELECT reminderLastSeq,reminderMessageCount FROM tasks WHERE id=$id";
        command.Parameters.AddWithValue("$id", taskId);
        using var row = command.ExecuteReader();
        Assert.True(row.Read());
        Assert.Equal(visible.Max(), row.GetInt64(0));
        Assert.Equal(visible.Length, row.GetInt32(1));
        Assert.DoesNotContain(
            fixture.Owner.Entry.Snapshot().History,
            message => message["__meta"]?["goalReminder"] is not null
        );
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Empty_background_or_awaited_operation_releases_without_provider_or_fake_input(
        bool background
    )
    {
        await using var fixture = await CompactFixture.CreateAsync(background);
        var admission = await fixture.Owner.Compactor.StartManualAsync();
        Assert.True(admission.Started);
        Assert.Equal(background, admission.Background);
        await fixture.Owner.Compactor.DrainAsync();
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(0, fixture.Peer.NormalRequests);
        Assert.False(fixture.Peer.PlanReached.Task.IsCompleted);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.False(fixture.Owner.Compacting);
        Assert.False(fixture.Owner.Entry.Snapshot().Busy);
        Assert.Empty(fixture.Owner.Entry.Snapshot().History);
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Empty(fixture.Store.Archive.ReadMessages());
    }

    [Fact]
    public async Task Failed_ready_planner_concludes_only_itself_and_preserves_followup_input()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.FailPlan = true;
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("ordinary after failed planner")
        );
        fixture.Peer.ReleasePlan();
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!fixture.Owner.Compactor.HasCompletedJob && DateTime.UtcNow < deadline)
            await Task.Delay(1);
        Assert.True(fixture.Owner.Compactor.HasCompletedJob);
        fixture.Peer.ReleaseForeground();
        await fixture.Owner.DrainForegroundAsync();
        await fixture.Owner.Compactor.DrainAsync();
        Assert.Equal(9, fixture.Peer.NormalRequests);
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Contains(
            fixture.Owner.Entry.Snapshot().History,
            row => row["parts"]?[0]?["text"]?.GetValue<string>() == "ordinary after failed planner"
        );
        Assert.Equal(0, fixture.Owner.Entry.BackgroundProcessorFailureCount);
        Assert.True(fixture.Owner.Entry.BestEffortFailureCount > 0);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Actual_background_owner_cancellation_at_authority_boundary_retains_only_committed_rows(
        bool postrename,
        bool failAfterRename
    )
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        var before = fixture.Owner.Entry.Snapshot();
        var archive = fixture.Store.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
        fixture.HoldStage = postrename
            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
            : AtomicJsonWriteStage.BeforeRename;
        fixture.FailHeldStage = failAfterRename;
        var admission = await fixture.Owner.Compactor.StartManualAsync();
        Assert.True(admission.Background);
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await File.WriteAllTextAsync(
            fixture.MemoryPath,
            "refreshed memory after planning admission"
        );
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = fixture.Owner.Compactor.StopAsync();
        Assert.False(stop.IsCompleted);
        fixture.StageRelease.Set();
        var outcome = await stop.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(!postrename, outcome.Cancelled);
        Assert.Equal(postrename, outcome.TooLate);
        var live = fixture.Owner.Entry.Snapshot();
        var stored = (await fixture.Store.LoadAsync("s"))!;
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.Empty(live.Queue);
        Assert.False(live.Busy);
        Assert.Equal(
            live.History.Select(row => row.ToJsonString()),
            stored.History.Select(row => row.ToJsonString())
        );
        Assert.Equal(
            archive,
            fixture.Store.Archive.ReadMessages().Take(archive.Length).Select(row => row.MessageJson)
        );
        if (postrename)
        {
            Assert.Single(fixture.Store.Archive.ReadBlocks());
            Assert.Equal(archive.Length + 1, fixture.Store.Archive.ReadMessages().Count);
            Assert.Contains(live.History, row => row["__meta"]?["contextBlock"] is JsonObject);
            Assert.Contains(
                "refreshed memory",
                SessionWait.Text(live.AuthorityEnvelope["persistentMemorySnapshot"])
            );
            Assert.Equal(before.HistoryVersion + 1, live.HistoryVersion);
        }
        else
        {
            Assert.Empty(fixture.Store.Archive.ReadBlocks());
            Assert.Equal(archive.Length, fixture.Store.Archive.ReadMessages().Count);
            Assert.Equal(
                before.History.Select(row => row.ToJsonString()),
                live.History.Select(row => row.ToJsonString())
            );
            Assert.Equal(
                before.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString(),
                live.AuthorityEnvelope["persistentMemorySnapshot"]!.ToJsonString()
            );
        }
        await fixture.Owner.Entry.SaveLane.SaveStrictAsync();
    }

    [Fact]
    public async Task Commit_refresh_uses_recorded_live_concrete_identity_not_the_new_planner_leaf()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        await fixture.Owner.UpdateModelAsync(new JsonObject { ["model"] = "b" });
        await File.WriteAllTextAsync(
            fixture.MemoryPath,
            "<foxwarm-if model-id=\"a/wire\">\nlive concrete memory\n</foxwarm-if>\n<foxwarm-if model-id=\"b/wire-b\">\nplanner concrete memory\n</foxwarm-if>\n"
        );
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("wire-b", fixture.Peer.PlanRequestModel);
        Assert.Contains("planner concrete memory", fixture.Peer.PlanInstructions);
        Assert.DoesNotContain("live concrete memory", fixture.Peer.PlanInstructions);
        fixture.Peer.ReleasePlan();
        await fixture.Owner.Compactor.DrainAsync();
        await fixture.Owner.DrainForegroundAsync();
        var memory = SessionWait.Text(
            fixture.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
        )!;
        Assert.Equal("a/wire", ConditionalMemory.ReadCurrentModelSnapshotId(memory));
        Assert.Contains("live concrete memory", memory);
        Assert.DoesNotContain("planner concrete memory", memory);
        Assert.Single(fixture.Store.Archive.ReadBlocks());
    }

    [Fact]
    public async Task Ready_during_held_producer_publication_cancellation_waits_for_exact_producer_and_preserves_ordinary_input()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldSignal = true;
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(fixture.Owner.Compactor.HasCompletedJob);
        Assert.DoesNotContain(
            fixture.Owner.Entry.Snapshot().Queue,
            row => row.Type == QueueItemType.CompactCommit
        );
        var stop = fixture.Owner.Compactor.StopAsync();
        Assert.False(stop.IsCompleted);
        fixture.StageRelease.Set();
        Assert.True((await stop.WaitAsync(TimeSpan.FromSeconds(5))).Cancelled);
        Assert.False(fixture.Owner.Compactor.Active);
        Assert.DoesNotContain(
            fixture.Owner.Entry.Snapshot().Queue,
            row => row.Type == QueueItemType.CompactCommit
        );
        Assert.Empty(fixture.Store.Archive.ReadBlocks());
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("ordinary after cancellation")
        );
        fixture.Peer.ReleaseForeground();
        await fixture.Owner.DrainForegroundAsync();
        Assert.Contains(
            fixture.Owner.Entry.Snapshot().History,
            row => row["parts"]?[0]?["text"]?.GetValue<string>() == "ordinary after cancellation"
        );
        Assert.Equal(0, fixture.Owner.Entry.BackgroundProcessorFailureCount);
    }

    [Fact]
    public async Task Applying_owner_survives_failed_signal_producer_until_postrename_cancellation_is_classified()
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.HoldSignal = true;
        fixture.FailHeldStage = true;
        fixture.HoldApplyAfterSignal = true;
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var applying = fixture.Owner.Compactor.ApplyCompletedAsync();
        fixture.StageRelease.Set();
        await fixture.ApplyReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(fixture.Owner.Compactor.Active);
        var stop = fixture.Owner.Compactor.StopAsync();
        Assert.False(stop.IsCompleted);
        fixture.ApplyRelease.Set();
        await applying.WaitAsync(TimeSpan.FromSeconds(5));
        var outcome = await stop.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(outcome.TooLate);
        Assert.False(outcome.Cancelled);
        Assert.Single(fixture.Store.Archive.ReadBlocks());
        Assert.False(fixture.Owner.Compactor.Active);
        fixture.Peer.ReleaseForeground();
        await fixture.Owner.DrainForegroundAsync();
    }

    [Fact]
    public async Task Wake_cleanup_is_operation_owned_across_clones_and_restart_stale_signal_preserves_declared_wait()
    {
        using var root = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(root.Path, "s");
        var registry = new SessionRegistry(store, new NoChat())
        {
            TriggerOverride = _ => Task.CompletedTask,
        };
        var entry = registry.Add("s");
        await entry.SaveLane.StartWaitAsync(
            JsonNode.Parse("""{"id":"wait-one","startedAt":1,"waitForInput":true}""")!.AsObject()
        );
        var first = new object();
        var second = new object();
        await entry.SaveLane.PublishCompactWakeAsync(first, CancellationToken.None);
        await entry.SaveLane.PublishCompactWakeAsync(second, CancellationToken.None);
        Assert.Same(first, entry.Snapshot().Queue[0].CompactOwner);
        Assert.Same(second, entry.Snapshot().Queue[1].CompactOwner);
        await entry.SaveLane.RemoveCompactWakeAsync(first);
        Assert.Same(second, Assert.Single(entry.Snapshot().Queue).CompactOwner);
        var restarted = new SessionRegistry(store, new NoChat())
        {
            TriggerOverride = _ => Task.CompletedTask,
        };
        var loaded = await restarted.LoadOrAddAsync("s");
        Assert.Null(Assert.Single(loaded.Snapshot().Queue).CompactOwner);
        await restarted.Runner.ProcessQueueAsync("s");
        Assert.Empty(loaded.Snapshot().Queue);
        Assert.Equal("wait-one", SessionWait.Text(loaded.Snapshot().Meta["wait"]?["id"]));
        Assert.Empty(loaded.Snapshot().History);
        Assert.False(loaded.Snapshot().Busy);
    }

    [Fact]
    public async Task Cancelled_live_memory_refresh_precedes_compact_preparation_and_does_not_poison_save_lane()
    {
        using var root = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(root.Path, "s");
        var registry = new SessionRegistry(store, new NoChat())
        {
            TriggerOverride = _ => Task.CompletedTask,
        };
        var entry = registry.Add("s");
        await entry.SaveLane.SaveStrictAsync();
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("acknowledged"));
        using var cancellation = new CancellationTokenSource();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var prepared = 0;
        var operation = entry.SaveLane.CommitCompactionAsync(
            _ =>
            {
                prepared++;
                throw new InvalidOperationException("not reached");
            },
            cancellation.Token,
            async (_, token) =>
            {
                reached.TrySetResult();
                await Task.Delay(Timeout.Infinite, token);
                return "not published";
            }
        );
        await reached.Task;
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Equal(0, prepared);
        Assert.Empty(store.Archive.ReadBlocks());
        Assert.Empty(store.Archive.ReadMessages());
        Assert.Single(entry.Snapshot().Queue);
        Assert.Single((await store.LoadAsync("s"))!.Queue);
        await entry.SaveLane.SaveStrictAsync();
    }

    [Fact]
    public void Awaited_phase_release_is_exact_lease_owned_and_wake_is_not_visible_input_count()
    {
        var models = HostModels.ForTest(
            new ResponsesClientOptions(new Uri("http://localhost"), "wire", "a/wire", "", "", 713)
        );
        var owner = new SessionOwner("s", "main", models)
        {
            Registry = new SessionRegistry(new InMemorySessionAuthorityStore(), new NoChat()),
        };
        var entry = owner.Registry.Add("s");
        var old = owner.BeginCompactPhase();
        var current = owner.BeginCompactPhase();
        owner.EndCompactPhase(old);
        Assert.True(owner.Compacting);
        owner.EndCompactPhase(current);
        Assert.False(owner.Compacting);
        entry.State.Queue.Add(new QueueItem(QueueItemType.CompactCommit));
        entry.State.Queue.Add(QueueItem.UserText("ordinary"));
        Assert.Equal(1, owner.Metadata().QueueLength);
        var dto = Foxwarm.Channels.WebUi.WebUiContract.History(
            entry.Snapshot(),
            models,
            false,
            false,
            null,
            null,
            null
        );
        Assert.Equal(1, dto["queueLength"]!.GetValue<int>());
        Assert.Single(dto["queuedMessages"]!.AsArray());
        Assert.Equal(0, dto["queuedPreviewOmittedCount"]!.GetValue<int>());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Real_ready_compact_without_advisory_marker_is_applied_before_retry_input_and_strict_failure_blocks_send(
        bool inputs,
        bool failApply
    )
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        var key = fixture.Owner.Entry.Snapshot().AuthorityEnvelope[
            "promptCacheKey"
        ]!.GetValue<string>();
        fixture.Peer.FailForegroundOnce = true;
        fixture.Peer.Phase = () => fixture.Owner.Compacting;
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (
            !fixture.Owner.Compactor.HasCompletedJob
            || !fixture
                .Owner.Entry.Snapshot()
                .Queue.Any(item => item.Type == QueueItemType.CompactCommit)
        )
            await Task.Delay(5, timeout.Token);
        // The confirmed contract does not depend on delivery of its advisory signal. Only remove that signal;
        // the actual producer, frozen plan, owner and persistence paths are unchanged.
        fixture.Owner.Entry.WithState(state =>
            state.Queue.RemoveAll(item => item.Type == QueueItemType.CompactCommit)
        );
        await File.WriteAllTextAsync(fixture.MemoryPath, "refreshed system snapshot during retry");
        if (inputs)
        {
            await fixture.Owner.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText("correction A")
            );
            await fixture.Owner.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText("correction B")
            );
        }
        if (failApply)
        {
            fixture.HoldStage = AtomicJsonWriteStage.BeforeRename;
            fixture.FailHeldStage = true;
            fixture.StageRelease.Set();
        }
        fixture.Peer.ReleaseForeground();
        await fixture.Owner.DrainForegroundAsync();
        var current = fixture.Owner.Entry.Snapshot();
        Assert.Equal(key, current.AuthorityEnvelope["promptCacheKey"]!.GetValue<string>());
        Assert.False(fixture.Owner.Compacting);
        if (failApply)
            Assert.True(
                fixture.StageReached.Task.IsCompleted,
                "Actual compact authority fault stage was reached."
            );
        Assert.Equal(failApply ? 8 : 9, fixture.Peer.NormalRequests);
        if (failApply)
        {
            Assert.IsType<ModelPreparationException>(
                fixture.Owner.Entry.LastBackgroundProcessorFailure
            );
            Assert.Equal(2, current.Queue.Count);
            Assert.DoesNotContain(
                current.History,
                row => row["__meta"]?["contextBlock"] is JsonObject
            );
        }
        else
        {
            Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
            Assert.Empty(current.Queue);
            Assert.Contains(current.History, row => row["__meta"]?["contextBlock"] is JsonObject);
            var body = fixture.Peer.NormalBodies.Last();
            Assert.Contains("CTX-BLOCK", body);
            Assert.Contains("refreshed system snapshot during retry", body);
            Assert.DoesNotContain("seed 0 ", body);
            Assert.False(fixture.Peer.CompactingAtSend.Last());
            if (inputs)
            {
                Assert.Contains("correction A", body);
                Assert.Contains("correction B", body);
                Assert.Single(
                    current.History,
                    row => row["parts"]!.ToJsonString().Contains("correction A")
                );
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_or_RunQueued_across_actual_retry_compact_write_rechecks_before_selecting_input(
        bool runQueued
    )
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.FailForegroundOnce = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await fixture.Owner.Compactor.StartManualAsync();
        await fixture.Peer.PlanReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleasePlan();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!fixture.Owner.Compactor.HasCompletedJob)
            await Task.Delay(5, timeout.Token);
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("cross compact correction")
        );
        fixture.HoldStage = AtomicJsonWriteStage.BeforeRename;
        fixture.Peer.ReleaseForeground();
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.DoesNotContain(
            fixture.Owner.Entry.Snapshot().History,
            row => row["parts"]!.ToJsonString().Contains("cross compact correction")
        );
        var action = runQueued
            ? (Task)fixture.Owner.Registry.Control.DequeueAsync("s")
            : fixture.Owner.Registry.Control.StopAsync("s");
        fixture.StageRelease.Set();
        await action;
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(runQueued ? 9 : 8, fixture.Peer.NormalRequests);
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Single(
            fixture.Owner.Entry.Snapshot().History,
            row => row["parts"]!.ToJsonString().Contains("cross compact correction")
        );
        Assert.False(fixture.Owner.Compacting);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_or_RunQueued_during_real_pending_ingress_after_backoff_does_not_dispatch_stale_context(
        bool runQueued
    )
    {
        await using var fixture = await CompactFixture.CreateAsync();
        await fixture.SeedAsync();
        fixture.Peer.FailForegroundOnce = true;
        await fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("hold foreground")
        );
        await fixture.Peer.ForegroundReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        fixture.Peer.ReleaseForeground();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (
            !fixture
                .Owner.Entry.Snapshot()
                .History.Any(row => row["__meta"]?["noticeType"]?.GetValue<string>() == "llm-retry")
        )
            await Task.Delay(5, timeout.Token);
        fixture.HoldIngress = true;
        var ingress = fixture.Owner.Registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("ingress correction")
        );
        await fixture.StageReached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Task.Delay(2100);
        Assert.Equal(8, fixture.Peer.NormalRequests);
        var action = runQueued
            ? (Task)fixture.Owner.Registry.Control.DequeueAsync("s")
            : fixture.Owner.Registry.Control.StopAsync("s");
        fixture.StageRelease.Set();
        await ingress;
        await action;
        await fixture.Owner.DrainForegroundAsync();
        Assert.Equal(runQueued ? 9 : 8, fixture.Peer.NormalRequests);
        Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        Assert.Single(
            fixture.Owner.Entry.Snapshot().History,
            row => row["parts"]!.ToJsonString().Contains("ingress correction")
        );
    }

    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        ) => throw new InvalidOperationException("control-only work must not call provider");
    }

    private sealed class CompactFixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly HttpClient http;
        internal readonly CompactPeer Peer = new();
        internal readonly TaskCompletionSource StageReached = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly ManualResetEventSlim StageRelease = new(false);
        internal AtomicJsonWriteStage? HoldStage;
        internal bool HoldSignal,
            FailHeldStage;
        internal bool HoldIngress;
        internal bool HoldApplyAfterSignal;
        internal readonly TaskCompletionSource ApplyReached = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly ManualResetEventSlim ApplyRelease = new(false);
        internal readonly PersistentSessionAuthorityStore Store;
        internal readonly SessionOwner Owner;
        internal readonly string MemoryPath;
        internal readonly SessionManager AuthorizationManager;
        internal readonly string TaskDataRoot;

        private CompactFixture(bool background)
        {
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            MemoryPath = Path.Combine(work, "memory", "MEMORY.md");
            Directory.CreateDirectory(Path.GetDirectoryName(MemoryPath)!);
            File.WriteAllText(MemoryPath, "initial memory");
            var authorityPath = Path.Combine(data, "state", "sessions", "s.json");
            Store = new PersistentSessionAuthorityStore(
                data,
                "s",
                authorityStageHook: stage =>
                {
                    if (
                        HoldApplyAfterSignal
                        && stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                        && JsonNode
                            .Parse(File.ReadAllText(authorityPath))!["historyVersion"]
                            ?.GetValue<long>() == 1
                    )
                    {
                        HoldApplyAfterSignal = false;
                        ApplyReached.TrySetResult();
                        if (!ApplyRelease.Wait(TimeSpan.FromSeconds(8)))
                            throw new TimeoutException("private applying barrier expired");
                    }
                    if (
                        stage != HoldStage
                        && !(
                            (HoldSignal || HoldIngress)
                            && stage == AtomicJsonWriteStage.BeforeRename
                        )
                    )
                        return;
                    var pending =
                        stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            ? authorityPath
                            : Directory
                                .GetFiles(Path.GetDirectoryName(authorityPath)!, "s.json.tmp-*")
                                .SingleOrDefault();
                    if (pending is null)
                        return;
                    var document = JsonNode.Parse(File.ReadAllText(pending))!.AsObject();
                    var matches =
                        HoldIngress
                            ? document["queue"]!.ToJsonString().Contains("ingress correction")
                        : HoldSignal
                            ? document["queue"]!
                                .AsArray()
                                .Any(row => row?["type"]?.GetValue<string>() == "compact-commit")
                        : document["historyVersion"]?.GetValue<long>() == 1;
                    if (!matches)
                        return;
                    HoldStage = null;
                    HoldSignal = false;
                    HoldIngress = false;
                    StageReached.TrySetResult();
                    if (!StageRelease.Wait(TimeSpan.FromSeconds(8)))
                        throw new TimeoutException("private compact barrier expired");
                    if (FailHeldStage)
                        throw new IOException("private postrename fault");
                }
            );
            http = new HttpClient(Peer) { Timeout = Timeout.InfiniteTimeSpan };
            var options = new ResponsesClientOptions(
                new Uri("http://localhost"),
                "wire",
                "a/wire",
                "",
                "",
                713
            );
            var models = HostModels.Parse(
                JsonNode
                    .Parse(
                        """{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire"],"contextLimit":20000},"b":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire-b"],"contextLimit":20000}}}"""
                    )!
                    .AsObject(),
                new JsonObject()
            );
            if (!background)
                models = HostModels.Parse(
                    JsonNode
                        .Parse(
                            """{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost","models":["wire"],"contextLimit":20000,"asyncCompact":false}}}"""
                        )!
                        .AsObject(),
                    new JsonObject()
                );
            var agents = new AgentCatalog(data, work);
            var skills = new Skills(agents, Path.Combine(temp.Path, "skills"));
            var memory = new AgentMemory(agents, skills);
            Owner = new SessionOwner("s", "main", models) { Archive = Store.Archive };
            var requests = new ModelRequestOwner(
                http,
                options,
                new ModelRouting(),
                images: Store.Images
            );
            var authorizationData = Path.Combine(temp.Path, "authorization-data");
            TaskDataRoot = authorizationData;
            var authorizationWork = Path.Combine(temp.Path, "authorization-work");
            Directory.CreateDirectory(authorizationWork);
            AuthorizationManager = new SessionManager(
                authorizationData,
                authorizationWork,
                options,
                models,
                Path.Combine(temp.Path, "skills")
            );
            var chat = new SessionChatService(
                requests,
                options,
                Owner,
                models,
                memory,
                (_, _) => { }
            );
            Owner.Registry = new SessionRegistry(Store, chat);
            Owner.Registry.Add("s");
            Owner.Compactor = new SessionCompactor(
                Owner,
                AuthorizationManager,
                Store,
                models,
                options,
                requests,
                memory
            );
            Owner.Registry.OnSafePoint = _ => Owner.Compactor.SafePointAsync();
            Owner.Registry.OnRetrySafePoint = _ =>
                Owner.Compactor.SafePointAsync(propagateFailure: true);
            Owner.Registry.HasCompletedCompact = _ => Owner.Compactor.HasCompletedJob;
            Owner.Registry.TriggerOverride = _ => Owner.StartProcessing();
        }

        internal static async Task<CompactFixture> CreateAsync(bool background = true)
        {
            var fixture = new CompactFixture(background);
            await fixture.Owner.Entry.SaveLane.SaveStrictAsync();
            return fixture;
        }

        internal async Task SeedAsync(byte[]? image = null)
        {
            for (var i = 0; i < 7; i++)
            {
                var seedText = "seed " + i + " " + new string('x', 5000);
                var item = QueueItem.UserText(seedText);
                if (i == 0 && image is not null)
                    item = item with
                    {
                        Parts =
                        [
                            new JsonObject { ["text"] = seedText },
                            new JsonObject
                            {
                                ["inlineData"] = new JsonObject
                                {
                                    ["mimeType"] = "image/png",
                                    ["data"] = Convert.ToBase64String(image),
                                },
                            },
                        ],
                    };
                await Owner.Registry.Ingress.EnqueueAsync("s", item);
                await Owner.DrainForegroundAsync();
            }
        }

        public async ValueTask DisposeAsync()
        {
            StageRelease.Set();
            ApplyRelease.Set();
            Peer.ReleaseForeground();
            Peer.ReleasePlan();
            if (Owner.Compactor.Active)
                await Owner.Compactor.StopAsync();
            await Owner.DrainAsync();
            await AuthorizationManager.DisposeAsync();
            http.Dispose();
            StageRelease.Dispose();
            ApplyRelease.Dispose();
            temp.Dispose();
        }
    }

    private sealed class CompactPeer : HttpMessageHandler
    {
        internal readonly TaskCompletionSource PlanReached =
                new(TaskCreationOptions.RunContinuationsAsynchronously),
            ForegroundReached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource plan =
                new(TaskCreationOptions.RunContinuationsAsynchronously),
            foreground = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string? PlanRequestModel,
            PlanInstructions;
        internal bool FailPlan,
            FailForegroundOnce;
        internal int NormalRequests;
        internal Func<bool>? Phase;
        internal readonly List<string> NormalBodies = [];
        internal readonly List<bool> CompactingAtSend = [];

        internal void ReleasePlan() => plan.TrySetResult();

        internal void ReleaseForeground() => foreground.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var owned = JsonNode.Parse(body)!.AsObject();
            var input = owned["input"]!
                .AsArray()
                .OfType<JsonObject>()
                .Where(row => SessionWait.Text(row["role"]) == "user")
                .SelectMany(row => row["content"]!.AsArray().OfType<JsonObject>())
                .Select(row => SessionWait.Text(row["text"]) ?? "")
                .ToArray();
            JsonArray output;
            if (input.Any(text => text.Contains("COMPACTION STARTED:", StringComparison.Ordinal)))
            {
                PlanRequestModel = SessionWait.Text(owned["model"]);
                PlanInstructions = SessionWait.Text(owned["instructions"]);
                PlanReached.TrySetResult();
                await plan.Task.WaitAsync(cancellationToken);
                if (FailPlan)
                    return new HttpResponseMessage(HttpStatusCode.BadRequest)
                    {
                        Content = new StringContent("planner rejected"),
                    };
                var ranges = Regex.Matches(
                    string.Join('\n', input),
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                var start = long.Parse(ranges[0].Groups[1].Value);
                var last = ranges[^1];
                var end = long.Parse(
                    last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                );
                var args = new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(
                        new JsonObject
                        {
                            ["level"] = 1,
                            ["sourceKind"] = "message",
                            ["sourceStart"] = start,
                            ["sourceEnd"] = end,
                            ["summary"] = "Prior context.",
                        }
                    ),
                };
                output = new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "function_call",
                        ["id"] = "output-plan",
                        ["call_id"] = "plan",
                        ["name"] = "submit_compact_plan",
                        ["arguments"] = args.ToJsonString(),
                    }
                );
            }
            else
            {
                Interlocked.Increment(ref NormalRequests);
                NormalBodies.Add(body);
                CompactingAtSend.Add(Phase?.Invoke() ?? false);
                if (input.LastOrDefault() == "hold foreground")
                {
                    ForegroundReached.TrySetResult();
                    await foreground.Task.WaitAsync(cancellationToken);
                }
                if (FailForegroundOnce)
                {
                    FailForegroundOnce = false;
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    {
                        Content = new StringContent("owned foreground retry"),
                    };
                }
                output = new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "message",
                        ["role"] = "assistant",
                        ["content"] = new JsonArray(
                            new JsonObject { ["type"] = "output_text", ["text"] = "answer" }
                        ),
                    }
                );
            }
            var payload = new JsonObject
            {
                ["type"] = "response.completed",
                ["response"] = new JsonObject
                {
                    ["id"] = "response",
                    ["status"] = "completed",
                    ["output"] = output,
                },
            };
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "data: " + payload.ToJsonString() + "\n\n",
                    Encoding.UTF8,
                    "text/event-stream"
                ),
            };
        }
    }
}
