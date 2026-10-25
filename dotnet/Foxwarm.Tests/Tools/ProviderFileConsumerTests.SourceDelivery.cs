using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Complete_source_reads_use_captured_target_cwd_not_display_previews_or_Main_path_joining()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await f.Owner.UpdateCwdAsync("opaque://root/scripts");
        var source =
            string.Concat(Enumerable.Repeat("# source padding αβγ\n", 60000)) + "return 713\n";
        await f.Seed("scripts/source.py", Encoding.UTF8.GetBytes(source));
        var result = await f.Call("run_script", new JsonObject { ["filePath"] = "source.py" });
        Success(result);
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        Assert.Equal(713, result["result"]!.GetValue<int>());
        var reads = (await f.Requests())
            .Where(call => call["request"]?["operation"]?.GetValue<string>() == "read")
            .ToArray();
        Assert.True(reads.Length > 16);
        Assert.All(
            reads,
            call =>
            {
                Assert.Equal("source.py", call["request"]!["path"]!.GetValue<string>());
                Assert.Equal(
                    "opaque://root/scripts",
                    call["request"]!["context"]!["cwd"]!.GetValue<string>()
                );
                Assert.InRange(call["request"]!["count"]!.GetValue<int>(), 1, 65536);
            }
        );
        Assert.Equal(f.Node, f.Manager.CurrentNode(f.Owner));
        Assert.False(File.Exists(Path.Combine(f.Work, "source.py")));
        var sourceRead = await Assert.ThrowsAsync<Foxwarm.ToolScript.ToolScriptDataLimitException>(
            () =>
                f.Manager.NodeProviders.ReadSourceAsync(
                    f.Node,
                    "source.py",
                    "opaque://root/scripts",
                    default,
                    size => new Foxwarm.ToolScript.ToolScriptDataBudget(1).Charge(size)
                )
        );
        Assert.NotNull(sourceRead);
    }

    [Theory]
    [InlineData("snapshot-append", 65535, true, 1)]
    [InlineData("snapshot-append", 65536, false, 2)]
    [InlineData("normal", 65536, true, 2)]
    [InlineData("premature-short", 65536, false, 1)]
    public async Task Complete_source_uses_fixed_chunks_short_read_termination_and_initial_stat_equality(
        string mode,
        int size,
        bool complete,
        int readCount
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(mode);
        const string ending = "\nreturn 713\n";
        await f.Seed(
            "source.py",
            Encoding.UTF8.GetBytes("#" + new string('x', size - ending.Length - 1) + ending)
        );
        var result = await f.Call(
            "run_script",
            new JsonObject { ["filePath"] = "source.py", ["node"] = f.Node }
        );
        Assert.Equal(complete, SessionWait.Text(result["status"]) == "completed");
        if (complete)
            Assert.Equal(713, result["result"]!.GetValue<int>());
        var reads = (await f.Requests())
            .Where(call => call["request"]?["operation"]?.GetValue<string>() == "read")
            .ToArray();
        Assert.Equal(readCount, reads.Length);
        Assert.All(reads, call => Assert.Equal(65536, call["request"]!["count"]!.GetValue<int>()));
        if (mode == "snapshot-append")
            Assert.True(new FileInfo(f.FilePath("source.py")).Length > size);
    }

    [Fact]
    public async Task Provider_yaml_delivery_keeps_transfer_MIME_and_stages_original_bytes_on_Main()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var bytes = Encoding.UTF8.GetBytes("name: provider\n");
        await f.Seed("settings.yaml", bytes);
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        var deliveries = 0;
        f.Manager.RegisterWebUiFileDelivery(
            (conversation, path, _) =>
            {
                Assert.Equal(f.Owner.Id, conversation);
                Assert.True(Path.IsPathFullyQualified(path));
                Assert.Equal(bytes, File.ReadAllBytes(path));
                deliveries++;
            }
        );
        var result = await f.Call(
            "send_file",
            new JsonObject { ["filePath"] = "settings.yaml", ["node"] = f.Node }
        );
        Success(result);
        Assert.Equal(1, deliveries);
        Assert.Equal("application/yaml", SessionWait.Text(result["fileDelivery"]?["mimeType"]));
        Assert.Equal(f.Node, SessionWait.Text(result["fileDelivery"]?["sourceNodeId"]));
        Assert.Equal("master", SessionWait.Text(result["fileDelivery"]?["downloadNodeId"]));
    }

    [Fact]
    public async Task Explicit_provider_source_is_separate_from_nested_live_Main_placement()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Seed(
            "source.py",
            Encoding.UTF8.GetBytes("return call_tool('read', {'filePath':'nested.txt'})['content']")
        );
        await File.WriteAllTextAsync(
            Path.Combine(f.Manager.AgentDirectory("main"), "nested.txt"),
            "nested-main"
        );
        var result = await f.Call(
            "run_script",
            new JsonObject { ["filePath"] = "source.py", ["node"] = f.Node }
        );
        Success(result);
        Assert.Equal("nested-main", result["result"]!.GetValue<string>());
        Assert.Equal("master", f.Manager.CurrentNode(f.Owner));
        Assert.All(
            (await f.Requests()).Where(call =>
                call["operation"]!.GetValue<string>() == "filesystem"
            ),
            call =>
            {
                Assert.Equal("source.py", call["request"]!["path"]!.GetValue<string>());
                Assert.Empty(call["request"]!["context"]!.AsObject());
            }
        );
    }

    [Fact]
    public async Task Explicit_builtin_identity_wins_without_discovering_the_selected_provider()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        var before = (await f.Requests()).Length;
        var result = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "builtin:run_script",
                ["source"] = "node",
                ["args"] = new JsonObject { ["code"] = "return 7" },
            }
        );
        Success(result);
        Assert.Equal(7, result["result"]!.GetValue<int>());
        Assert.Equal(before, (await f.Requests()).Length);
    }

    [Fact]
    public async Task Lost_write_receipt_retains_one_effect_without_automatic_replay()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create("lost-write");
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        var result = await f.Call(
            "write",
            new JsonObject
            {
                ["filePath"] = "effect.txt",
                ["content"] = "once",
                ["createDirs"] = true,
            }
        );
        Assert.NotNull(result["error"]);
        Assert.Equal("once", await File.ReadAllTextAsync(f.FilePath("effect.txt")));
        Assert.Single(
            await f.Requests(),
            call => call["request"]?["operation"]?.GetValue<string>() == "write"
        );
    }

    [Theory]
    [InlineData("short-read")]
    [InlineData("invalid-base64")]
    public async Task Invalid_or_incomplete_source_bytes_are_not_presented_as_complete(string mode)
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create(mode);
        await f.Seed("source.py", Encoding.UTF8.GetBytes("return 1"));
        var result = await f.Call(
            "run_script",
            new JsonObject { ["filePath"] = "source.py", ["node"] = f.Node }
        );
        Assert.NotEqual("completed", SessionWait.Text(result["status"]));
        Assert.Single(
            await f.Requests(),
            call => call["request"]?["operation"]?.GetValue<string>() == "read"
        );
    }

    [Fact]
    public async Task Maximum_qualified_source_image_export_and_delivery_keep_cache_and_receipts_on_Main()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create(maximumId: true);
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var reference = await f.Manager.Images.PutAsync(bytes, "image/png", "provider-image");
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["inlineDataRef"] = reference.DeepClone() }
                ),
            }
        );
        var exported = await f.Call(
            "image_write_to_file",
            new JsonObject
            {
                ["id"] = "provider-image",
                ["filePath"] = "images/export.png",
                ["node"] = f.Node,
            }
        );
        Success(exported);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(f.FilePath("images/export.png")));
        f.Manager.BeforeFileStage = (_, stage) => stage == "after-write"
            ? Task.FromException(new IOException("Owned post-export failure."))
            : Task.CompletedTask;
        JsonObject partial;
        try
        {
            partial = await f.Call("image_write_to_file", new JsonObject
            {
                ["id"] = "provider-image", ["filePath"] = "images/partial.png", ["node"] = f.Node,
            });
        }
        finally
        {
            f.Manager.BeforeFileStage = null;
        }
        Assert.Equal("image_export_partial", SessionWait.Text(partial["error"]?["type"]));
        Assert.True(partial["fileWritten"]!.GetValue<bool>());
        Assert.False(string.IsNullOrEmpty(SessionWait.Text(partial["fullPath"])));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(f.FilePath("images/partial.png")));
        Assert.Single(await f.Requests(), call =>
            SessionWait.Text(call["request"]?["operation"]) == "write"
            && SessionWait.Text(call["request"]?["path"]) == "images/partial.png");
        Assert.False(File.Exists(Path.Combine(f.Work, "images", "partial.png")));
        var read = await f.Call("read", Args("images/export.png"));
        Success(read);
        Assert.Equal("image/png", SessionWait.Text(read["mimeType"]));
        var deliveries = 0;
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery(
            (conversation, path, _) =>
            {
                Assert.Equal(f.Owner.Id, conversation);
                Assert.True(Path.IsPathFullyQualified(path));
                Assert.Equal(bytes, File.ReadAllBytes(path));
                deliveries++;
            }
        );
        var delivery = await f.Call(
            "send_file",
            new JsonObject { ["filePath"] = "images/export.png", ["node"] = f.Node }
        );
        Success(delivery);
        Assert.Equal(1, deliveries);
        Assert.Equal(f.Node, SessionWait.Text(delivery["fileDelivery"]?["sourceNodeId"]));
        Assert.Equal("master", SessionWait.Text(delivery["fileDelivery"]?["downloadNodeId"]));
        Assert.Equal(193, SessionWait.Text(delivery["fileDelivery"]?["sourceNodeId"])!.Length);
        Assert.DoesNotContain(
            f.Target,
            SessionWait.Text(delivery["fileDelivery"]?["downloadPath"])!
        );
    }

    [Fact]
    public async Task Real_policy_checks_all_copy_endpoints_and_provider_current_matchers_before_effects()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await f.Seed("source", Encoding.UTF8.GetBytes("allowed"));
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: { provider: fixture }\n"
        );
        var args = new JsonObject
        {
            ["sourceNode"] = f.Node,
            ["sourcePath"] = "source",
            ["targetNode"] = f.Node,
            ["targetPath"] = "destination",
        };
        Success(await f.Call("copy_between_nodes", args));
        Assert.Equal("allowed", await File.ReadAllTextAsync(f.FilePath("destination")));
        args["targetNode"] = "master";
        args["targetPath"] = "denied-main";
        var before = (await f.Requests()).Length;
        Assert.NotNull((await f.Call("copy_between_nodes", args))["error"]);
        Assert.Equal(before, (await f.Requests()).Length);
        args["sourceNode"] = "master";
        args["sourcePath"] = "denied-main";
        args["targetNode"] = f.Node;
        Assert.NotNull((await f.Call("copy_between_nodes", args))["error"]);
        await File.WriteAllTextAsync(
            policy,
            "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: { current: true }\n"
        );
        Success(await f.Call("read", Args("source")));
        var explicitMain = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "node:master/read", ["args"] = Args("source") }
        );
        Assert.NotNull(explicitMain["error"]);
        Success(await f.Call("exec", Exec("printf allowed")));
        var deniedExec = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "node:other/target/exec",
                ["args"] = Exec("printf forbidden"),
            }
        );
        Assert.NotNull(deniedExec["error"]);
        var otherRequests = await File.ReadAllLinesAsync(
            Path.Combine(f.OtherTarget, "calls.jsonl")
        );
        Assert.DoesNotContain(
            otherRequests,
            line => JsonNode.Parse(line)!["operation"]!.GetValue<string>() == "exec-start"
        );
    }

    [Fact]
    public async Task Persisted_selection_admission_binding_and_attachment_ingress_use_generic_identity_without_Agent_directory_invention()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        SessionManager.ValidateExecutionEnvironment(
            f.Owner.Entry.Snapshot().AuthorityEnvelope,
            f.Work,
            f.Work
        );
        var selected = f.Owner.Entry.Snapshot().AuthorityEnvelope[
            "currentNode"
        ]!.GetValue<string>();
        Assert.Equal(f.Node, selected);
        await f.Manager.SetAgentNodeAsync("main", f.Node);
        Assert.Equal(f.Node, f.Manager.BoundNode("main"));
        f.Manager.RequireFileIngressOwner(f.Owner);
        f.Manager.AttachConfiguredChannel("fixture:inbound", f.Owner.Id);
        var parts = await f.Manager.SaveInboundChannelFileAsync(
            "fixture",
            "inbound",
            [1, 2, 3],
            "attachment.bin",
            "application/octet-stream",
            "",
            default
        );
        Assert.Contains(f.Node, parts[0]["text"]!.GetValue<string>());
        var writes = (await f.Requests())
            .Where(call => call["request"]?["flag"]?.GetValue<string>() == "wx")
            .ToArray();
        Assert.Single(writes);
        var body = writes[0]["request"]!;
        Assert.StartsWith(".temp/channel-files/fixture/", body["path"]!.GetValue<string>());
        Assert.Empty(body["context"]!.AsObject());
        Assert.DoesNotContain("agent", body.ToJsonString());
    }

    [Fact]
    public async Task Oversized_WebUI_originals_keep_Main_for_selection_only_and_use_existing_bound_provider_file_transport()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var bytes = new byte[Foxwarm.Images.ImageInputPolicy.MaxBytes + 1];
        ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png).CopyTo(bytes, 0);
        var uploads = new Foxwarm.Channels.WebUi.WebUiUploadedFiles(f.Manager);
        var staging = Path.Combine(uploads.Root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            await f.Manager.SelectNodeAsync(f.Owner, f.Node);
            foreach (var bound in new[] { false, true })
            {
                if (bound)
                    await f.Manager.SetAgentNodeAsync("main", f.Node);
                var input = Path.Combine(staging, "original.png");
                await File.WriteAllBytesAsync(input, bytes);
                using var admission = f.Manager.BeginFileIngress(f.Owner);
                var result = await uploads.PrepareAsync(
                    new JsonObject
                    {
                        ["uploadedFiles"] = new JsonArray(
                            new JsonObject
                            {
                                ["path"] = input,
                                ["filename"] = "original.png",
                                ["mimeType"] = "image/png",
                            }
                        ),
                    },
                    f.Owner,
                    default
                );
                Assert.Single(result.Parts);
                Assert.StartsWith("<foxwarm-file ", result.Parts[0]["text"]!.ToString());
                Assert.Null(result.Parts[0]["inlineDataRef"]);
                var saved = Assert.Single(result.SavedFiles);
                Assert.Equal(bound ? f.Node : "master", saved["node"]!.ToString());
                var path = saved["path"]!.ToString();
                var actual = bound
                    ? f.FilePath(
                        path.StartsWith("opaque://root/", StringComparison.Ordinal)
                            ? path["opaque://root/".Length..]
                            : path
                    )
                    : path;
                Assert.Equal(bytes, await File.ReadAllBytesAsync(actual));
                Assert.False(File.Exists(input));
                var calls = (await f.Requests()).Length;
                await f.Manager.Images.HydrateAsync(
                    [
                        new JsonObject
                        {
                            ["role"] = "user",
                            ["parts"] = new JsonArray(
                                result.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
                            ),
                        },
                    ],
                    "responses"
                );
                Assert.Equal(calls, (await f.Requests()).Length);
            }
            Assert.False(Directory.Exists(f.Manager.Images.BlobRoot));
        }
        finally
        {
            Directory.Delete(staging, true);
        }
    }
}
