using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class MainFileDeliveryTests
{
    private static JsonObject Args(string path) => new() { ["filePath"] = path };

    private static string? Error(JsonObject value) => SessionWait.Text(value["error"]?["type"]);

    private static JsonObject Image(JsonObject reference) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = reference.DeepClone() }),
        };

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        internal ToolRegistry Registry = null!;
        private Foxwarm.McpClient mcp = null!;

        internal static async Task<Fixture> Create(JsonObject? isolation = null)
        {
            var f = new Fixture();
            Console.WriteLine("Owned file fixture=" + f.Temp.Path);
            if (isolation is not null)
            {
                Directory.CreateDirectory(Path.Combine(f.Data, "state"));
                await File.WriteAllTextAsync(
                    Path.Combine(f.Data, "state", "agents.json"),
                    new JsonObject
                    {
                        ["version"] = 2,
                        ["agents"] = new JsonArray(),
                        ["metadata"] = new JsonObject { ["main"] = isolation },
                    }.ToJsonString()
                );
            }
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
            await f.Manager.LoadAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "source", null, null);
            f.mcp = new(f.Data);
            var definitions = FileDeliveryDefinitions.Definitions();
            foreach (var item in UnifiedToolDefinitions.All())
                definitions.Add(item?.DeepClone());
            f.Registry = SessionToolExecutor.CreateRegistry(definitions, f.mcp, _ => f.Work);
            f.Tools = new(new WorkspaceTools(f.Work), f.Owner, f.Manager, f.Registry);
            f.Tools.BeginTurn();
            return f;
        }

        internal async Task<JsonObject> Call(
            string name,
            JsonObject args,
            CancellationToken token = default
        ) =>
            (
                await Tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["name"] = name,
                        ["args"] = args.DeepClone(),
                    },
                    token
                )
            )!.AsObject();

        internal async Task<JsonObject> Reference(
            string id,
            SKEncodedImageFormat format = SKEncodedImageFormat.Png
        ) =>
            await Manager.Images.PutAsync(
                ImageCodecTests.Raster(format),
                format == SKEncodedImageFormat.Jpeg ? "image/jpeg" : "image/png",
                id
            );

        public async ValueTask DisposeAsync()
        {
            await mcp.DisposeAsync();
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Theory]
    [InlineData(null, "application/octet-stream")]
    [InlineData("", "application/octet-stream")]
    [InlineData("application/yaml", "application/yaml")]
    public void Receipt_preserves_remote_MIME_or_uses_ordinary_fallback(
        string? remoteMime,
        string expected
    )
    {
        using var temp = new TempDirectory();
        var receipt = FileDeliveryArtifact.Create(
            "session",
            "main/target",
            "config.yaml",
            12,
            Path.Combine(temp.Path, "config.yaml"),
            "two",
            remoteMime
        );
        Assert.Equal(expected, SessionWait.Text(receipt["mimeType"]));
    }

    [Fact]
    public async Task Default_readiness_requires_real_binding_adapter_regular_file_and_keeps_history_and_target_queue_unchanged()
    {
        await using var f = await Fixture.Create();
        var path = Path.Combine(f.Work, "ordinary.txt");
        await File.WriteAllTextAsync(path, "download me");
        Assert.Contains("no attached", (await f.Call("send_file", Args(path))).ToJsonString());
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        Assert.Contains("unavailable", (await f.Call("send_file", Args(path))).ToJsonString());
        var history = f.Owner.History().Select(row => row.ToJsonString()).ToArray();
        var callbacks = 0;
        string? caption = null;
        f.Manager.RegisterWebUiFileDelivery(
            (conversation, file, text) =>
            {
                Assert.Equal(f.Owner.Id, conversation);
                Assert.Equal(path, file);
                callbacks++;
                caption = text;
            }
        );
        var args = Args(" \t$fw_agentdir/ordinary.txt\n");
        args["caption"] = " first ";
        args["text"] = "other";
        var result = await f.Call("send_file", args);
        Assert.Null(Error(result));
        Assert.Equal(path, SessionWait.Text(result["fullPath"]));
        var receipt = result["fileDelivery"]!.AsObject();
        Assert.Equal(1, receipt["version"]!.GetValue<int>());
        Assert.Equal("session", SessionWait.Text(receipt["targetKind"]));
        Assert.Equal(f.Owner.Id, SessionWait.Text(receipt["targetId"]));
        Assert.Equal("ordinary.txt", SessionWait.Text(receipt["fileName"]));
        Assert.Equal("text/plain", SessionWait.Text(receipt["mimeType"]));
        Assert.Equal(11, receipt["sizeBytes"]!.GetValue<long>());
        Assert.Equal(path, SessionWait.Text(receipt["downloadPath"]));
        Assert.Equal("master", SessionWait.Text(receipt["downloadNodeId"]));
        Assert.Equal("master", SessionWait.Text(receipt["sourceNodeId"]));
        Assert.Equal("first", caption);
        Assert.Equal(1, callbacks);
        Assert.Equal(history, f.Owner.History().Select(row => row.ToJsonString()));
        Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        Assert.NotNull(Error(await f.Call("send_file", Args(f.Work))));
        f.Manager.RegisterWebUiFileDelivery(null);
        Assert.NotNull(Error(await f.Call("send_file", Args(path))));
    }

    [Fact]
    public async Task Explicit_alias_member_and_persisted_conversation_resolve_without_target_hydration_and_dangling_or_unknown_are_failures()
    {
        await using var f = await Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "target", null, null);
        var row = f.Manager.Catalog.Get(target.Id)!;
        row["aliases"] = new JsonArray("recipient");
        f.Manager.Catalog.Upsert([row]);
        f.Manager.AttachWebUi(target.Id, target);
        var path = Path.Combine(f.Work, "file");
        await File.WriteAllTextAsync(path, "x");
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var args = Args(path);
        args["sessionId"] = "recipient";
        Assert.Null(Error(await f.Call("send_file", args)));
        Assert.Empty(target.Entry.Snapshot().Queue);
        args = Args(path);
        args["channelTargetId"] = "webui:target";
        var channelResult = await f.Call("send_file", args);
        Assert.Null(Error(channelResult));
        Assert.Equal("channel", SessionWait.Text(channelResult["fileDelivery"]?["targetKind"]));
        Assert.Equal("webui:target", SessionWait.Text(channelResult["fileDelivery"]?["targetId"]));
        foreach (var destination in new[] { "webui:missing", "external:target", "bad" })
        {
            args = Args(path);
            args["channelTargetId"] = destination;
            var failed = await f.Call("send_file", args);
            Assert.NotNull(Error(failed));
            Assert.Null(failed["fileDelivery"]);
        }
        var channels = JsonNode
            .Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "channels.json")))!
            .AsObject();
        channels["channels"]!["webui:dangling"] = new JsonObject { ["sessionId"] = "gone" };
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "channels.json"),
            channels.ToJsonString()
        );
        args = Args(path);
        args["channelTargetId"] = "webui:dangling";
        Assert.NotNull(Error(await f.Call("send_file", args)));
        args["sessionId"] = f.Owner.Id;
        Assert.NotNull(Error(await f.Call("send_file", args)));
    }

    [Fact]
    public async Task Mixed_binding_delivery_retains_external_failure_and_send_only_skip_without_fake_empty_success()
    {
        await using var f = await Fixture.Create();
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        var path = Path.Combine(f.Work, "file");
        await File.WriteAllTextAsync(path, "x");
        var channels = JsonNode
            .Parse(await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "channels.json")))!
            .AsObject();
        channels["channels"]!["missing:room"] = new JsonObject { ["sessionId"] = f.Owner.Id };
        channels["channels"]!["other:room"] = new JsonObject
        {
            ["sessionId"] = f.Owner.Id,
            ["mode"] = "send-only",
        };
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "channels.json"),
            channels.ToJsonString()
        );
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var result = await f.Call("send_file", Args(path));
        Assert.Null(Error(result));
        Assert.Contains("Delivered: 1", result.ToJsonString());
        Assert.Contains("missing:room", result.ToJsonString());
        Assert.Contains("send-only", result.ToJsonString());
        channels["channels"]!.AsObject().Remove("webui:" + f.Owner.Id);
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "channels.json"),
            channels.ToJsonString()
        );
        Assert.NotNull(Error(await f.Call("send_file", Args(path))));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("current")]
    [InlineData("CURRENT")]
    [InlineData("master")]
    public async Task Established_Main_selector_defaults_are_accepted_and_neutral_dispatch_uses_same_capability(
        string? node
    )
    {
        await using var f = await Fixture.Create();
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var path = Path.Combine(f.Work, "file");
        await File.WriteAllTextAsync(path, "x");
        var args = Args(path);
        args["node"] = node;
        Assert.Null(
            Error(
                await f.Call(
                    "call_tool",
                    new JsonObject { ["toolId"] = "builtin:send_file", ["args"] = args }
                )
            )
        );
        args["node"] = "unknown";
        Assert.NotNull(Error(await f.Call("send_file", args)));
        args["node"] = true;
        Assert.NotNull(Error(await f.Call("send_file", args)));
        var definitions = f.Registry.ModelDefinitions();
        Assert.All(
            definitions
                .OfType<JsonObject>()
                .Where(item =>
                    SessionWait.Text(item["name"]) is "send_file" or "image_write_to_file"
                ),
            item =>
            {
                var properties = item["parameters"]!["properties"]!.AsObject();
                Assert.Equal(
                    new[] { "__cancelTool", "__cancelAllToolsThisTurn" },
                    properties.Select(pair => pair.Key).TakeLast(2)
                );
                Assert.False(properties.ContainsKey("confirmation"));
            }
        );
    }

    [Fact]
    public async Task Actual_shared_token_and_raw_export_whitespace_facts_drive_policy_before_creating_parents()
    {
        await using var f = await Fixture.Create();
        var reference = await f.Reference("owned");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules: [{id: paths, action: deny, match: {tool: {source: builtin, name: [send_file, image_write_to_file]}, path: {anyNotWithin: '${agent.dir}/allowed'}}}]"
            ),
            CancellationToken.None
        );
        var denied = await f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "owned", ["filePath"] = "$fw_agentdir/denied/new/image.png" }
        );
        Assert.Equal("tool_authorization_denied", Error(denied));
        Assert.False(Directory.Exists(Path.Combine(f.Work, "denied")));
        var ok = await f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "owned", ["filePath"] = "$fw_agentdir/allowed/image.bin" }
        );
        Assert.Null(Error(ok));
        Assert.Equal(
            await f.Manager.Images.ReadAsync(reference),
            await File.ReadAllBytesAsync(Path.Combine(f.Work, "allowed", "image.bin"))
        );
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        Assert.Null(Error(await f.Call("send_file", Args(" \t$fw_agentdir/allowed/image.bin\n"))));
        var raw = " $fw_agentdir/allowed/literal.png";
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject { ["id"] = "owned", ["filePath"] = raw }
                )
            )
        );
        var files = f.Manager.IdentityWorkspace(f.Owner);
        Assert.EndsWith(raw, files.Paths.FilePath(raw));
    }

    [Fact]
    public async Task Exact_isolated_allow_does_not_bypass_own_path_Main_shared_agents_self_or_attached_destination()
    {
        var isolation = new JsonObject
        {
            ["isolated"] = true,
            ["toolRules"] = new JsonArray(
                new JsonObject
                {
                    ["source"] = "builtin",
                    ["effect"] = "allow",
                    ["tool"] = "send_file",
                },
                new JsonObject
                {
                    ["source"] = "builtin",
                    ["effect"] = "allow",
                    ["tool"] = "image_write_to_file",
                }
            ),
        };
        await using var f = await Fixture.Create(isolation);
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var own = Path.Combine(f.Work, "own");
        await File.WriteAllTextAsync(own, "x");
        Assert.Null(Error(await f.Call("send_file", Args(own))));
        var outside = Path.Combine(f.Temp.Path, "outside");
        await File.WriteAllTextAsync(outside, "x");
        Assert.Equal("tool_authorization_denied", Error(await f.Call("send_file", Args(outside))));
        var shared = Path.Combine(f.Work, "agents", "other");
        Directory.CreateDirectory(Path.GetDirectoryName(shared)!);
        await File.WriteAllTextAsync(shared, "x");
        File.CreateSymbolicLink(Path.Combine(f.Work, "alias"), shared);
        Assert.Equal(
            "tool_authorization_denied",
            Error(await f.Call("send_file", Args(Path.Combine(f.Work, "alias"))))
        );
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        var args = Args(own);
        args["sessionId"] = other.Id;
        Assert.Equal("tool_authorization_denied", Error(await f.Call("send_file", args)));
        args = Args(own);
        args["channelTargetId"] = "webui:" + other.Id;
        Assert.Equal("tool_authorization_denied", Error(await f.Call("send_file", args)));
        var reference = await f.Reference("owned");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        Assert.Equal(
            "tool_authorization_denied",
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject
                    {
                        ["id"] = "owned",
                        ["filePath"] = Path.Combine(f.Temp.Path, "new", "out"),
                    }
                )
            )
        );
        Assert.False(Directory.Exists(Path.Combine(f.Temp.Path, "new")));
    }

    [Fact]
    public async Task Newest_current_image_original_bytes_beat_Archive_and_filename_does_not_transcode_or_grant_global_blob_access()
    {
        await using var f = await Fixture.Create();
        var older = await f.Reference("same");
        var newer = await f.Reference("same", SKEncodedImageFormat.Jpeg);
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(older), Image(newer));
        var path = Path.Combine(f.Work, "export", "misleading.png");
        var args = new JsonObject { ["id"] = "same", ["filePath"] = path };
        Assert.Null(Error(await f.Call("image_write_to_file", args)));
        Assert.Equal(await f.Manager.Images.ReadAsync(newer), await File.ReadAllBytesAsync(path));
        Assert.NotNull(Error(await f.Call("image_write_to_file", args)));
        args["overwrite"] = true;
        Assert.Null(Error(await f.Call("image_write_to_file", args)));
        var unrelated = await f.Reference("not-in-history");
        Assert.NotNull(
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject
                    {
                        ["id"] = unrelated["blobId"]!.ToString(),
                        ["filePath"] = Path.Combine(f.Work, "no", "image"),
                    }
                )
            )
        );
        Assert.False(Directory.Exists(Path.Combine(f.Work, "no")));
        await File.WriteAllTextAsync(
            f.Manager.Images.ResolveBlob(newer["blobId"]!.ToString()),
            "corrupt"
        );
        args["filePath"] = Path.Combine(f.Work, "corrupt-new", "image");
        Assert.NotNull(Error(await f.Call("image_write_to_file", args)));
        Assert.False(Directory.Exists(Path.Combine(f.Work, "corrupt-new")));
    }

    [Fact]
    public async Task Effective_nested_and_zero_caps_and_committed_move_resolve_owned_immutable_originals_after_clear_and_parent_deletion()
    {
        await using var f = await Fixture.Create();
        var zero = await f.Manager.ForkAsync(f.Owner, "zero");
        var reference = await f.Reference("archived");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        var child = await f.Manager.ForkAsync(f.Owner, "child");
        var nested = await f.Manager.ForkAsync(child, "nested");
        await f.Manager.ClearAsync(nested);
        var audit = f.Owner.Archive.ReadMessages().Single().MessageJson;
        await f.Manager.MoveIdentityAsync(f.Owner, new JsonObject { ["newSessionId"] = "moved" });
        await f.Manager.DeleteAsync(f.Owner.Id);
        var path = Path.Combine(f.Work, "nested.bin");
        Assert.Null(
            Error(
                await f.Manager.ExportImageAsync(
                    nested,
                    f.Manager.IdentityWorkspace(nested),
                    new JsonObject { ["id"] = "archived", ["filePath"] = path },
                    CancellationToken.None
                )
            )
        );
        Assert.Equal(
            await f.Manager.Images.ReadAsync(reference),
            await File.ReadAllBytesAsync(path)
        );
        Assert.Equal(audit, nested.Archive.ReadEffectiveMessagesRange(1, 1).Single().MessageJson);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.ExportImageAsync(
                zero,
                f.Manager.IdentityWorkspace(zero),
                new JsonObject
                {
                    ["id"] = "archived",
                    ["filePath"] = Path.Combine(f.Work, "zero.bin"),
                },
                CancellationToken.None
            )
        );
    }

    [Fact]
    public async Task Export_follows_final_symlink_for_overwrite_and_before_effect_move_uses_current_owner_then_after_write_keeps_actual_old_path()
    {
        await using var f = await Fixture.Create();
        var reference = await f.Reference("owned");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeFileStage = (_, stage) =>
        {
            if (stage != "before-effect")
                return Task.CompletedTask;
            reached.TrySetResult();
            return release.Task;
        };
        var pending = f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "owned", ["filePath"] = "$fw_agentdir/first.bin" }
        );
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.MoveIdentityAsync(
            f.Owner,
            new JsonObject
            {
                ["newSessionId"] = "moved",
                ["createAgent"] = true,
                ["newAgentName"] = "destination",
            }
        );
        release.SetResult();
        Assert.Null(Error(await pending));
        var actual = Path.Combine(f.Work, "agents", "destination", "first.bin");
        Assert.True(File.Exists(actual));
        Assert.False(File.Exists(Path.Combine(f.Work, "first.bin")));
        var link = Path.Combine(Path.GetDirectoryName(actual)!, "link");
        File.CreateSymbolicLink(link, actual);
        var args = new JsonObject
        {
            ["id"] = "owned",
            ["filePath"] = link,
            ["overwrite"] = true,
        };
        f.Manager.BeforeFileStage = null;
        Assert.Null(Error(await f.Call("image_write_to_file", args)));
        Assert.NotNull(new FileInfo(link).LinkTarget);
        Assert.Equal(
            await f.Manager.Images.ReadAsync(reference),
            await File.ReadAllBytesAsync(actual)
        );
        reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeFileStage = (_, stage) =>
        {
            if (stage != "after-write")
                return Task.CompletedTask;
            reached.TrySetResult();
            return release.Task;
        };
        pending = f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "owned", ["filePath"] = "$fw_agentdir/second.bin" }
        );
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.MoveIdentityAsync(
            f.Owner,
            new JsonObject { ["newSessionId"] = "again", ["newAgentName"] = "main" }
        );
        release.SetResult();
        var result = await pending;
        Assert.Null(Error(result));
        Assert.Equal(
            Path.Combine(Path.GetDirectoryName(actual)!, "second.bin"),
            SessionWait.Text(result["fullPath"])
        );
        Assert.False(File.Exists(Path.Combine(f.Work, "second.bin")));
    }

    [Fact]
    public async Task File_delivery_to_a_cold_alias_member_checks_only_Main_metadata_and_original_bindings()
    {
        await using var f = await Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "cold", null, null);
        f.Manager.AttachWebUi(target.Id, target);
        var row = f.Manager.Catalog.Get(target.Id)!;
        row["aliases"] = new JsonArray("cold-alias");
        f.Manager.Catalog.Upsert([row]);
        var path = Path.Combine(f.Work, "cold-file");
        await File.WriteAllTextAsync(path, "x");
        await f.Manager.DisposeAsync();
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
        await f.Manager.LoadAsync();
        f.Owner = await f.Manager.RequiredAsync("source");
        var admissions = 0;
        f.Manager.AdmissionReadObserved = _ => admissions++;
        f.Manager.RegisterWebUiFileDelivery(
            (conversation, _, _) => Assert.Equal("cold", conversation)
        );
        var args = Args(path);
        args["sessionId"] = "cold-alias";
        Assert.Null(
            Error(
                await f.Manager.SendFileAsync(
                    f.Owner,
                    f.Manager.IdentityWorkspace(f.Owner),
                    args,
                    CancellationToken.None
                )
            )
        );
        Assert.Equal(0, admissions);
        Assert.Null(f.Manager.Find("cold"));
    }

    [Fact]
    public async Task Byte_export_of_owned_HEIC_needs_no_decoder_and_postwrite_failure_reports_existing_effect_without_retry()
    {
        await using var f = await Fixture.Create();
        var repository = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var bytes = await File.ReadAllBytesAsync(
            Path.Combine(repository, "src", "testFixtures", "synthetic-alpha-3x2.heic")
        );
        var reference = await f.Manager.Images.PutAsync(bytes, "image/heic", "heic");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        var path = Path.Combine(f.Work, "original.png");
        Assert.Null(
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject { ["id"] = "heic", ["filePath"] = path }
                )
            )
        );
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
        f.Manager.BeforeFileStage = (_, stage) =>
            stage == "after-write"
                ? Task.FromException(new IOException("Synthetic postwrite failure"))
                : Task.CompletedTask;
        path = Path.Combine(f.Work, "partial.heic");
        var partial = await f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "heic", ["filePath"] = path }
        );
        Assert.Equal("image_export_partial", Error(partial));
        Assert.True(partial["fileWritten"]!.GetValue<bool>());
        Assert.Equal(path, SessionWait.Text(partial["fullPath"]));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task Accepted_export_is_drained_before_delete_and_retired_source_cannot_repeat_or_redirect_the_effect()
    {
        await using var f = await Fixture.Create();
        var reference = await f.Reference("owned");
        await ForkClearLifecycleTests.AppendAsync(f.Owner, Image(reference));
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Manager.BeforeFileStage = (_, stage) =>
        {
            if (stage != "before-effect")
                return Task.CompletedTask;
            reached.TrySetResult();
            return release.Task;
        };
        var path = Path.Combine(f.Work, "drained.bin");
        var pending = f.Call(
            "image_write_to_file",
            new JsonObject { ["id"] = "owned", ["filePath"] = path }
        );
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var deletion = f.Manager.DeleteAsync(f.Owner.Id);
        try
        {
            await Task.Delay(30);
            Assert.False(deletion.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        var result = await pending;
        await deletion;
        Assert.Null(Error(result));
        Assert.Equal(
            await f.Manager.Images.ReadAsync(reference),
            await File.ReadAllBytesAsync(path)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync("main", "source", null, null)
        );
        var replacement = await f.Manager.CreateNamedAsync("main", "replacement", null, null);
        Assert.Empty(replacement.History());
        Assert.Empty(replacement.Entry.Snapshot().Queue);
        Assert.NotNull(
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject
                    {
                        ["id"] = "owned",
                        ["filePath"] = path,
                        ["overwrite"] = true,
                    }
                )
            )
        );
    }
}
