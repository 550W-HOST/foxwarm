using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class MainLocalToolsTests
{
    private static string? Error(JsonObject result) => SessionWait.Text(result["error"]?["type"]);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        private Foxwarm.McpClient mcp = null!;

        internal static async Task<Fixture> Create()
        {
            var f = new Fixture();
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(
                Path.Combine(f.Temp.Path, "data"),
                Path.Combine(f.Temp.Path, "work"),
                options,
                HostModels.ForTest(options)
            );
            await f.Manager.LoadAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "tools", null, null);
            f.mcp = new(Path.Combine(f.Temp.Path, "data"));
            var defs = MainLocalToolDefinitions.Definitions();
            foreach (var definition in ObservationToolDefinitions.Definitions())
                defs.Add(definition.DeepClone());
            foreach (var definition in WorkspaceTools.Definitions().OfType<JsonObject>())
                defs.Add(definition.DeepClone());
            foreach (var definition in FileDeliveryDefinitions.Definitions().OfType<JsonObject>())
                defs.Add(definition.DeepClone());
            foreach (var definition in ArchiveControlTools.Definitions().OfType<JsonObject>())
                defs.Add(definition.DeepClone());
            foreach (var definition in UnifiedToolDefinitions.All().OfType<JsonObject>())
                defs.Add(definition.DeepClone());
            var workspace = f.Manager.IdentityWorkspace(f.Owner)!;
            var toolRoot = workspace.ToolDirectory;
            var registry = SessionToolExecutor.CreateRegistry(defs, f.mcp, _ => toolRoot);
            f.Tools = new(new WorkspaceTools(toolRoot), f.Owner, f.Manager, registry);
            f.Tools.BeginTurn();
            return f;
        }

        internal Task<JsonObject> Call(string name, JsonObject args) =>
            Tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["name"] = name,
                    ["args"] = args,
                },
                default
            );

        public async ValueTask DisposeAsync()
        {
            await mcp.DisposeAsync();
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Memory_tools_use_agent_namespace_and_actual_mutations()
    {
        await using var f = await Fixture.Create();
        var memory = f.Manager.MemoryDirectory(f.Owner.Agent);
        var created = await f.Call(
            "write_memory",
            new JsonObject { ["filePath"] = "notes/item.md", ["content"] = "one\n" }
        );
        Assert.Null(Error(created));
        Assert.Equal(
            "one\n",
            await File.ReadAllTextAsync(Path.Combine(memory, "notes", "item.md"))
        );
        Assert.Contains(
            "one",
            (
                await f.Call(
                    "read_memory",
                    new JsonObject { ["filePath"] = "memory//notes/item.md" }
                )
            )["output"]!.ToString()
        );
        Assert.NotNull(
            Error(await f.Call("read_memory", new JsonObject { ["filePath"] = "memory" }))
        );
        Assert.Null(
            Error(
                await f.Call(
                    "edit_memory",
                    new JsonObject
                    {
                        ["filePath"] = "notes/item.md",
                        ["oldText"] = "one",
                        ["newText"] = "two",
                    }
                )
            )
        );
        Assert.Null(
            Error(
                await f.Call(
                    "apply_patch_memory",
                    new JsonObject
                    {
                        ["input"] =
                            "*** Begin Patch\n*** Add File: notes/added.md\n+added\n*** End Patch",
                    }
                )
            )
        );
        var emptyCreated = await f.Call(
            "write_memory",
            new JsonObject { ["filePath"] = "notes/empty.md", ["content"] = "" }
        );
        Assert.True(Error(emptyCreated) is null, emptyCreated.ToJsonString());
        var emptyEdited = await f.Call(
            "edit_memory",
            new JsonObject
            {
                ["filePath"] = "notes/empty.md",
                ["oldText"] = "",
                ["newText"] = "head",
            }
        );
        Assert.True(Error(emptyEdited) is null, emptyEdited.ToJsonString());
        Assert.Equal(
            "head",
            await File.ReadAllTextAsync(Path.Combine(memory, "notes", "empty.md"))
        );
        Assert.NotNull(
            Error(
                await f.Call("delete_memory", new JsonObject { ["filePath"] = "notes/missing.md" })
            )
        );
        Assert.Null(
            Error(
                await f.Call(
                    "write_memory",
                    new JsonObject { ["filePath"] = "notes/partial.md", ["content"] = "old" }
                )
            )
        );
        var partial = await f.Call(
            "apply_patch_memory",
            new JsonObject
            {
                ["input"] =
                    "*** Begin Patch\n*** Update File: notes/partial.md\n-old\n+new\n*** Update File: notes/missing.md\n-old\n+new\n*** End Patch",
            }
        );
        Assert.Equal("tool_error", Error(partial));
        Assert.Contains("Applied operations:", partial["error"]!["message"]!.GetValue<string>());
        Assert.Equal(
            "new",
            await File.ReadAllTextAsync(Path.Combine(memory, "notes", "partial.md"))
        );
        Assert.Null(
            Error(await f.Call("delete_memory", new JsonObject { ["filePath"] = "notes/item.md" }))
        );
        Assert.False(File.Exists(Path.Combine(memory, "notes", "item.md")));
        Assert.True(File.Exists(Path.Combine(memory, "notes", "added.md")));
        Assert.NotNull(
            Error(
                await f.Call(
                    "write_memory",
                    new JsonObject { ["filePath"] = "notes/added.md", ["content"] = "again" }
                )
            )
        );
        var outside = Path.Combine(f.Temp.Path, "outside");
        await File.WriteAllTextAsync(outside, "secret");
        File.CreateSymbolicLink(Path.Combine(memory, "link.md"), outside);
        Assert.NotNull(
            Error(await f.Call("read_memory", new JsonObject { ["filePath"] = "link.md" }))
        );
        var outsideDir = Path.Combine(f.Temp.Path, "outside-dir");
        Directory.CreateDirectory(outsideDir);
        File.CreateSymbolicLink(Path.Combine(memory, "linked"), outsideDir);
        Assert.NotNull(
            Error(
                await f.Call(
                    "apply_patch_memory",
                    new JsonObject
                    {
                        ["input"] =
                            "*** Begin Patch\n*** Add File: linked/new.md\n+bad\n*** End Patch",
                    }
                )
            )
        );
        Assert.False(File.Exists(Path.Combine(outsideDir, "new.md")));
        Assert.NotNull(
            Error(
                await f.Call(
                    "apply_patch_memory",
                    new JsonObject
                    {
                        ["input"] =
                            "*** Begin Patch\n*** Add File: /tmp/absolute-memory.md\n+bad\n*** End Patch",
                    }
                )
            )
        );
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: allow\nrules:\n- id: deny-memory\n  action: deny\n  match: {tool: {source: builtin, name: write_memory}}"
            ),
            CancellationToken.None
        );
        var denied = await f.Call(
            "write_memory",
            new JsonObject { ["filePath"] = "notes/denied.md", ["content"] = "no" }
        );
        Assert.Equal("tool_authorization_denied", Error(denied));
        Assert.False(File.Exists(Path.Combine(memory, "notes", "denied.md")));
        var unified = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["source"] = "builtin",
                ["name"] = "read_memory",
                ["args"] = new JsonObject { ["filePath"] = "notes/added.md" },
            }
        );
        Assert.Null(Error(unified));
    }

    [Fact]
    public async Task List_agents_reports_catalog_without_hydrating_new_main()
    {
        await using var f = await Fixture.Create();
        var result = await f.Call("list_agents", new JsonObject());
        Assert.Null(Error(result));
        Assert.Contains("**main**", result["output"]!.GetValue<string>());
    }

    [Fact]
    public async Task Image_crop_is_session_owned_and_can_be_saved()
    {
        await using var f = await Fixture.Create();
        var source = await f.Manager.Images.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png),
            "image/png",
            "source"
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "source" },
                        ["inlineDataRef"] = source,
                    }
                ),
            }
        );
        var cropped = await f.Call(
            "image_crop",
            new JsonObject
            {
                ["id"] = "source",
                ["x"] = 0,
                ["y"] = 0,
                ["width"] = 1,
                ["height"] = 1,
            }
        );
        Assert.Null(Error(cropped));
        Assert.Equal(1, cropped["crop"]!["width"]!.GetValue<int>());
        var carrier = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "crop",
                        ["name"] = "image_crop",
                        ["response"] = cropped,
                    },
                }
            ),
        };
        await f.Manager.Images.ExternalizeMessageAsync(carrier);
        await ForkClearLifecycleTests.AppendAsync(f.Owner, carrier);
        var path = Path.Combine(f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory, "cropped.png");
        Assert.Null(
            Error(
                await f.Call(
                    "image_write_to_file",
                    new JsonObject { ["id"] = "crop#1", ["filePath"] = path }
                )
            )
        );
        Assert.True(File.Exists(path));
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        var otherReference = await f.Manager.Images.PutAsync(
            PixelImage(SKEncodedImageFormat.Png),
            "image/png",
            "other-source"
        );
        await ForkClearLifecycleTests.AppendAsync(
            other,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "other-source" },
                        ["inlineDataRef"] = otherReference,
                    }
                ),
            }
        );
        Assert.NotNull(
            Error(
                await f.Call(
                    "image_crop",
                    new JsonObject
                    {
                        ["id"] = "other-source",
                        ["x"] = 0,
                        ["y"] = 0,
                        ["width"] = 1,
                        ["height"] = 1,
                    }
                )
            )
        );
    }

    [Theory]
    [InlineData(SKEncodedImageFormat.Png, "image/png")]
    [InlineData(SKEncodedImageFormat.Jpeg, "image/jpeg")]
    [InlineData(SKEncodedImageFormat.Webp, "image/webp")]
    public async Task Image_crop_decodes_expected_selection_and_preserves_supported_format(
        SKEncodedImageFormat format,
        string mime
    )
    {
        await using var f = await Fixture.Create();
        var sourceId = "format-" + format;
        var sourceBytes = PixelImage(format);
        var reference = await f.Manager.Images.PutAsync(sourceBytes, mime, sourceId);
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = sourceId },
                        ["inlineDataRef"] = reference,
                    }
                ),
            }
        );
        var result = await f.Call(
            "image_crop",
            new JsonObject
            {
                ["id"] = sourceId,
                ["x"] = 1,
                ["y"] = 0,
                ["width"] = 1,
                ["height"] = 1,
            }
        );
        Assert.Null(Error(result));
        Assert.Equal(mime, result["mimeType"]!.GetValue<string>());
        var bytes = Convert.FromBase64String(result["inlineData"]!["data"]!.GetValue<string>());
        using var decoded = SKBitmap.Decode(bytes);
        using var original = SKBitmap.Decode(sourceBytes);
        Assert.Equal(1, decoded.Width);
        Assert.Equal(1, decoded.Height);
        var pixel = decoded.GetPixel(0, 0);
        var expected = original.GetPixel(1, 0);
        Assert.InRange(Math.Abs(pixel.Red - expected.Red), 0, 12);
        Assert.InRange(Math.Abs(pixel.Green - expected.Green), 0, 12);
        Assert.InRange(Math.Abs(pixel.Blue - expected.Blue), 0, 12);
    }

    [Fact]
    public async Task Image_crop_converts_gif_first_frame_to_png()
    {
        await using var f = await Fixture.Create();
        var reference = await f.Manager.Images.PutAsync(
            Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
            "image/gif",
            "gif-source"
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "gif-source" },
                        ["inlineDataRef"] = reference,
                    }
                ),
            }
        );
        var result = await f.Call(
            "image_crop",
            new JsonObject
            {
                ["id"] = "gif-source",
                ["x"] = 0,
                ["y"] = 0,
                ["width"] = 1,
                ["height"] = 1,
            }
        );
        Assert.Null(Error(result));
        Assert.Equal("image/png", result["mimeType"]!.GetValue<string>());
        Assert.Contains("first frame", result["output"]!.GetValue<string>());
        using var decoded = SKBitmap.Decode(
            Convert.FromBase64String(result["inlineData"]!["data"]!.GetValue<string>())
        );
        Assert.Equal(1, decoded.Width);
        Assert.Equal(1, decoded.Height);
    }

    [Fact]
    public async Task Image_crop_decodes_heif_original_to_png_at_original_coordinates()
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "HEIF crop test requires the assigned Source root."
            );
        var bytes = await File.ReadAllBytesAsync(
            Path.Combine(root, "src", "testFixtures", "synthetic-3x2.heic")
        );
        await using var f = await Fixture.Create();
        var reference = await f.Manager.Images.PutAsync(bytes, "image/heic", "heif-source");
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "heif-source" },
                        ["inlineDataRef"] = reference,
                    }
                ),
            }
        );
        var result = await f.Call(
            "image_crop",
            new JsonObject
            {
                ["id"] = "heif-source",
                ["x"] = 1,
                ["y"] = 0,
                ["width"] = 1,
                ["height"] = 1,
            }
        );
        Assert.True(Error(result) is null, result.ToJsonString());
        Assert.Equal("image/png", result["mimeType"]!.GetValue<string>());
        using var decoded = SKBitmap.Decode(
            Convert.FromBase64String(result["inlineData"]!["data"]!.GetValue<string>())
        );
        Assert.Equal(1, decoded.Width);
        Assert.Equal(1, decoded.Height);
        var original = HeifDecoder.DecodeImage(bytes);
        var expected = new SKColor(
            original.Rgba[(0 * original.Width + 1) * 4],
            original.Rgba[(0 * original.Width + 1) * 4 + 1],
            original.Rgba[(0 * original.Width + 1) * 4 + 2],
            original.Rgba[(0 * original.Width + 1) * 4 + 3]
        );
        var actual = decoded.GetPixel(0, 0);
        Assert.InRange(Math.Abs(actual.Red - expected.Red), 0, 2);
        Assert.InRange(Math.Abs(actual.Green - expected.Green), 0, 2);
        Assert.InRange(Math.Abs(actual.Blue - expected.Blue), 0, 2);
    }

    [Fact]
    public async Task Real_main_turn_dispatches_local_tools_and_externalizes_then_saves_crop()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (index, stream, _) =>
            {
                JsonArray output;
                if (index == 0)
                {
                    output = new JsonArray(
                        FunctionCall(
                            "call-write",
                            "write_memory",
                            new JsonObject
                            {
                                ["filePath"] = "notes/main.txt",
                                ["content"] = "normal",
                            }
                        ),
                        FunctionCall(
                            "call-read",
                            "read_memory",
                            new JsonObject { ["filePath"] = "notes/main.txt" }
                        ),
                        FunctionCall(
                            "call-patch",
                            "apply_patch_memory",
                            new JsonObject
                            {
                                ["input"] =
                                    "*** Begin Patch\n*** Update File: notes/main.txt\n-normal\n+patched\n*** End Patch",
                            }
                        ),
                        FunctionCall("call-agents", "list_agents", new JsonObject()),
                        FunctionCall(
                            "call-crop",
                            "image_crop",
                            new JsonObject
                            {
                                ["id"] = "source",
                                ["x"] = 1,
                                ["y"] = 0,
                                ["width"] = 1,
                                ["height"] = 1,
                            }
                        )
                    );
                }
                else if (index == 1)
                    output = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "local tools complete",
                                }
                            ),
                        }
                    );
                else if (index == 2)
                    output = new JsonArray(
                        FunctionCall(
                            "call-save",
                            "image_write_to_file",
                            new JsonObject
                            {
                                ["id"] = "call-crop#1",
                                ["filePath"] = "auto-crop.png",
                            }
                        )
                    );
                else
                    output = new JsonArray(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "crop saved" }
                            ),
                        }
                    );
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "local-tools-" + index,
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
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "local-tools", null, null);
        var source = await manager.Images.PutAsync(
            PixelImage(SKEncodedImageFormat.Png),
            "image/png",
            "source"
        );
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "source" },
                        ["inlineDataRef"] = source,
                    }
                ),
            }
        );
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("run local tools"));
        await owner.DrainForegroundAsync();
        var memory = manager.MemoryDirectory(owner.Agent);
        Assert.Equal(
            "patched",
            await File.ReadAllTextAsync(Path.Combine(memory, "notes", "main.txt"))
        );
        Assert.Contains(
            owner.History(),
            row => row.ToJsonString().Contains("local tools complete", StringComparison.Ordinal)
        );
        Assert.Contains(
            owner.History(),
            row => row.ToJsonString().Contains("call-crop#1", StringComparison.Ordinal)
        );
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("save the crop"));
        await owner.DrainForegroundAsync();
        Assert.True(
            File.Exists(
                Path.Combine(manager.IdentityWorkspace(owner)!.ToolDirectory, "auto-crop.png")
            )
        );
        using var decoded = SKBitmap.Decode(
            await File.ReadAllBytesAsync(
                Path.Combine(manager.IdentityWorkspace(owner)!.ToolDirectory, "auto-crop.png")
            )
        );
        Assert.Equal(1, decoded.Width);
        Assert.Equal(SKColors.Blue, decoded.GetPixel(0, 0));
    }

    [Fact]
    public async Task Large_text_edits_and_binary_patch_delete_use_normal_file_dispatch()
    {
        await using var f = await Fixture.Create();
        var workspace = f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory;
        var largeText = new string('a', 1_048_600) + "\nneedle\n";
        await File.WriteAllTextAsync(Path.Combine(workspace, "large.txt"), largeText);

        var edit = await f.Call(
            "edit",
            new JsonObject
            {
                ["filePath"] = "large.txt",
                ["oldText"] = "needle",
                ["newText"] = "edited",
            }
        );
        Assert.Null(Error(edit));
        Assert.Contains(
            "edited",
            await File.ReadAllTextAsync(Path.Combine(workspace, "large.txt"))
        );

        var patchText = new string('b', 1_048_600);
        var patch = await f.Call(
            "apply_patch",
            new JsonObject
            {
                ["input"] =
                    "*** Begin Patch\n*** Add File: large-patch.txt\n+"
                    + patchText
                    + "\n*** End Patch",
            }
        );
        Assert.Null(Error(patch));
        Assert.True(new FileInfo(Path.Combine(workspace, "large-patch.txt")).Length > 1_048_576);

        await File.WriteAllBytesAsync(
            Path.Combine(workspace, "binary.bin"),
            [0x00, 0xFF, 0x10, 0x80]
        );
        var delete = await f.Call(
            "apply_patch",
            new JsonObject
            {
                ["input"] = "*** Begin Patch\n*** Delete File: binary.bin\n*** End Patch",
            }
        );
        Assert.Null(Error(delete));
        Assert.False(File.Exists(Path.Combine(workspace, "binary.bin")));
    }

    [Fact]
    public async Task Hidden_archive_tools_read_effective_messages_and_blocks_without_default_injection()
    {
        await using var f = await Fixture.Create();
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "archived first" }),
            }
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Owner,
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "archived second" }),
            }
        );
        f.Owner.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                f.Owner.Id,
                f.Owner.Agent,
                7,
                1,
                "message",
                1,
                2,
                null,
                1,
                2,
                1000,
                2000,
                "summary seven",
                null,
                3000
            ),
        ]);

        var messages = await f.Call(
            "get_archived_messages",
            new JsonObject
            {
                ["startSeq"] = 1,
                ["endSeq"] = 2,
                ["previewLength"] = 1000,
            }
        );
        Assert.Null(Error(messages));
        Assert.Contains("#1 time", messages["output"]!.GetValue<string>());
        Assert.Contains("archived first", messages["output"]!.GetValue<string>());

        var blocks = await f.Call(
            "get_archived_blocks",
            new JsonObject { ["startId"] = 7, ["endId"] = 7 }
        );
        Assert.Null(Error(blocks));
        Assert.Contains("B#7", blocks["output"]!.GetValue<string>());
        Assert.Contains("summary seven", blocks["output"]!.GetValue<string>());

        var injected = f
            .Manager.ModelDefinitions(f.Owner)
            .Select(item => item!["name"]!.GetValue<string>())
            .ToArray();
        Assert.DoesNotContain("get_archived_messages", injected);
        Assert.DoesNotContain("get_archived_blocks", injected);
        Assert.DoesNotContain("stop_session", injected);

        var missing = await f.Call(
            "get_archived_messages",
            new JsonObject { ["sessionId"] = "missing" }
        );
        Assert.Null(Error(missing));
        Assert.Contains("No archived messages", missing["output"]!.GetValue<string>());
    }

    [Fact]
    public async Task Stop_session_idle_missing_and_self_stop_preserve_normal_effects()
    {
        await using var f = await Fixture.Create();
        var idle = await f.Call("stop_session", new JsonObject { ["sessionId"] = f.Owner.Id });
        Assert.Null(Error(idle));
        Assert.Contains("idle", idle["output"]!.GetValue<string>());
        Assert.False(f.Owner.Entry.Snapshot().Stopping);

        var missing = await f.Call("stop_session", new JsonObject { ["sessionId"] = "missing" });
        Assert.Equal("tool_error", Error(missing));
        Assert.Contains("not found", missing["error"]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task Session_status_targets_the_real_owner_and_does_not_admit_unknown_sessions()
    {
        await using var f = await Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "status-target", null, null);
        target.Entry.WithState(state =>
        {
            state.AuthorityEnvelope["cwd"] = "/target/cwd";
            state.AuthorityEnvelope["persistentMemorySnapshot"] = "target-only memory";
            state.History.Add(
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "target-only history" }),
                }
            );
            state.Meta["messageCount"] = state.History.Count;
        });
        var before = f.Manager.Owners().Count();
        var status = await f.Call(
            "session",
            new JsonObject { ["action"] = "status", ["sessionId"] = target.Id }
        );
        Assert.True(Error(status) is null, status.ToJsonString());
        var output = status["output"]!.GetValue<string>();
        Assert.Contains($"session id: `{target.Id}`", output);
        Assert.Contains("/target/cwd", output);
        Assert.Contains("messages: 1", output);

        var unified = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["source"] = "builtin",
                ["name"] = "session",
                ["args"] = new JsonObject
                {
                    ["action"] = "status",
                    ["sessionId"] = target.Id,
                },
            }
        );
        Assert.True(Error(unified) is null, unified.ToJsonString());
        Assert.Contains($"session id: `{target.Id}`", unified["output"]!.GetValue<string>());

        var missing = await f.Call(
            "session",
            new JsonObject { ["action"] = "status", ["sessionId"] = "missing-target" }
        );
        Assert.Null(Error(missing));
        Assert.Contains("Session `missing-target` not found.", missing["output"]!.GetValue<string>());
        Assert.Equal(before, f.Manager.Owners().Count());
    }

    [Fact]
    public async Task Session_update_parent_uses_catalog_topology_and_hot_owner_state()
    {
        await using var f = await Fixture.Create();
        var parent = await f.Manager.CreateNamedAsync("main", "parent-target", null, null);
        var child = await f.Manager.CreateNamedAsync("main", "child-target", null, null);

        var attached = await f.Call(
            "session",
            new JsonObject
            {
                ["action"] = "update-parent",
                ["sessionId"] = child.Id,
                ["parentSessionId"] = parent.Id,
            }
        );
        Assert.True(Error(attached) is null, attached.ToJsonString());
        Assert.Equal(child.Id, attached["sessionId"]!.GetValue<string>());
        Assert.Equal(parent.Id, attached["parentSessionId"]!.GetValue<string>());
        Assert.Null(attached["previousParentSessionId"]);
        Assert.Equal(parent.Id, f.Manager.Catalog.Get(child.Id)!["parentSessionId"]!.GetValue<string>());
        Assert.Equal(parent.Id, child.Metadata().ParentSessionId);
        Assert.Equal(parent.Id, child.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]!.GetValue<string>());
        await f.Manager.SendAsync(parent, child.Id, "routing probe", trigger: false);
        Assert.Equal("parent", child.Entry.Snapshot().Queue[^1].SourceSessionRelation);

        var noop = await f.Call(
            "session",
            new JsonObject
            {
                ["action"] = "update-parent",
                ["sessionId"] = child.Id,
                ["parentSessionId"] = parent.Id,
            }
        );
        Assert.Null(Error(noop));
        Assert.Equal(parent.Id, noop["previousParentSessionId"]!.GetValue<string>());
        Assert.Equal(parent.Id, noop["parentSessionId"]!.GetValue<string>());

        var detached = await f.Call(
            "session",
            new JsonObject
            {
                ["action"] = "update-parent",
                ["sessionId"] = child.Id,
                ["parentSessionId"] = null,
            }
        );
        Assert.Null(Error(detached));
        Assert.Equal(parent.Id, detached["previousParentSessionId"]!.GetValue<string>());
        Assert.Null(detached["parentSessionId"]);
        Assert.Null(child.Metadata().ParentSessionId);
        Assert.Null(child.Entry.Snapshot().AuthorityEnvelope["parentSessionId"]);

        var reattached = await f.Call(
            "session",
            new JsonObject
            {
                ["action"] = "update-parent",
                ["sessionId"] = child.Id,
                ["parentSessionId"] = parent.Id,
            }
        );
        Assert.Null(Error(reattached));

        var cycle = await f.Call(
            "session",
            new JsonObject
            {
                ["action"] = "update-parent",
                ["sessionId"] = parent.Id,
                ["parentSessionId"] = child.Id,
            }
        );
        Assert.Equal("agent_tool_error", Error(cycle));
        Assert.Contains("cycle", cycle["error"]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task Cross_target_stop_requires_permission_and_stops_a_busy_target()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                JsonArray output;
                if (index == 0)
                    output = new JsonArray(
                        FunctionCall(
                            "target-exec",
                            "exec",
                            new JsonObject { ["command"] = "sleep 30" }
                        )
                    );
                else if (index == 1)
                    output = new JsonArray(
                        FunctionCall(
                            "stop-target",
                            "stop_session",
                            new JsonObject { ["sessionId"] = "target" }
                        )
                    );
                else
                    output = new JsonArray(
                        new JsonObject { ["type"] = "text", ["text"] = "denied turn complete" }
                    );
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = $"response-{index}",
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
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        var target = await manager.CreateNamedAsync("main", "target", null, null);
        var source = await manager.CreateNamedAsync("main", "source", null, null);
        await target.Registry.Ingress.EnqueueAsync(target.Id, QueueItem.UserText("run"));
        await peer.RequestAt(0);
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!target.Processing && DateTime.UtcNow < deadline)
            await Task.Yield();
        Assert.True(target.Processing);
        await manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: allow\nrules:\n- id: deny-stop\n  action: deny\n  match: {tool: {source: builtin, name: stop_session}}"
            ),
            CancellationToken.None
        );
        await source.Registry.Ingress.EnqueueAsync(source.Id, QueueItem.UserText("try stop"));
        await peer.RequestAt(1);
        await peer.RequestAt(2);
        Assert.True(target.Processing);
        await manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: allow"),
            CancellationToken.None
        );
        await using var mcp = new Foxwarm.McpClient(Path.Combine(temp.Path, "mcp"));
        var definitions = MainLocalToolDefinitions.Definitions();
        foreach (var definition in ArchiveControlTools.Definitions().OfType<JsonObject>())
            definitions.Add(definition.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => manager.IdentityWorkspace(source)!.ToolDirectory
        );
        var tools = new SessionToolExecutor(
            new WorkspaceTools(manager.IdentityWorkspace(source)!.ToolDirectory),
            source,
            manager,
            registry
        );
        tools.BeginTurn();
        var stopped = await tools.ExecuteAsync(
            new JsonObject
            {
                ["id"] = "direct-stop",
                ["name"] = "stop_session",
                ["args"] = new JsonObject { ["sessionId"] = target.Id },
            },
            default
        );
        Assert.Null(Error(stopped));
        Assert.Contains("in-flight request was canceled", stopped["output"]!.GetValue<string>());
        await target.DrainForegroundAsync();
        Assert.False(target.Entry.Snapshot().Busy);
        Assert.False(target.Entry.Snapshot().Stopping);
        Assert.Contains(
            target.History(),
            row => row.ToJsonString().Contains("sleep 30", StringComparison.Ordinal)
        );
        Assert.Contains(
            source.History(),
            row => row.ToJsonString().Contains("stop_session", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Real_main_self_stop_commits_the_tool_pair_and_skips_the_followup_request()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
            {
                var output = new JsonArray(
                    FunctionCall(
                        "call-stop",
                        "stop_session",
                        new JsonObject { ["sessionId"] = "self-stop" }
                    ),
                    FunctionCall(
                        "call-archive",
                        "get_archived_messages",
                        new JsonObject { ["startSeq"] = 1, ["endSeq"] = 1 }
                    )
                );
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject { ["id"] = "self-stop", ["output"] = output },
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
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "self-stop", null, null);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("stop this turn"));
        await owner.DrainForegroundAsync();

        Assert.Equal(1, peer.RequestCount);
        var toolRows = owner
            .History()
            .Where(row => row["role"]?.GetValue<string>() == "tool")
            .ToArray();
        Assert.Single(toolRows);
        Assert.Contains(
            toolRows,
            row => row.ToJsonString().Contains("stop_session", StringComparison.Ordinal)
        );
        Assert.Contains(
            toolRows,
            row => row.ToJsonString().Contains("get_archived_messages", StringComparison.Ordinal)
        );
        Assert.False(owner.Entry.Snapshot().Stopping);
        Assert.Empty(owner.Entry.Snapshot().Queue);
    }

    private static JsonObject FunctionCall(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["id"] = id,
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    private static byte[] PixelImage(SKEncodedImageFormat format)
    {
        using var bitmap = new SKBitmap(
            new SKImageInfo(2, 1, SKColorType.Rgba8888, SKAlphaType.Premul)
        );
        bitmap.SetPixel(0, 0, SKColors.Red);
        bitmap.SetPixel(1, 0, SKColors.Blue);
        using var image = SKImage.FromBitmap(bitmap);
        using var encoded = image.Encode(format, 100)!;
        return encoded.ToArray();
    }
}
