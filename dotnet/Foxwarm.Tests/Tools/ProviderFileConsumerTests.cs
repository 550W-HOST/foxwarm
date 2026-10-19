using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "main");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal string Target => Path.Combine(Temp.Path, "target");
        internal string OtherTarget => Path.Combine(Temp.Path, "other-target");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        internal ToolRegistry Registry = null!;
        private Foxwarm.McpClient mcp = null!;
        internal string Provider = "fixture";
        internal string Local = "target";
        internal string Node => Provider + "/" + Local;

        internal static async Task<Fixture> Create(string mode = "normal", bool maximumId = false)
        {
            var f = new Fixture();
            Directory.CreateDirectory(Path.Combine(f.Data, "state"));
            Directory.CreateDirectory(f.Target);
            if (maximumId)
            {
                f.Provider = new string('p', 64);
                f.Local = new string('n', 128);
                await File.WriteAllTextAsync(Path.Combine(f.Target, "node-id"), f.Local);
            }
            var app = new JsonObject
            {
                ["vector"] = false,
                ["nodeProviders"] = new JsonObject
                {
                    [f.Provider] = ExecutableNodeProviderTests.Configuration(f.Target, mode),
                    ["other"] = ExecutableNodeProviderTests.Configuration(f.OtherTarget),
                },
            };
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "config.yaml"),
                app.ToJsonString()
            );
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "models.yaml"),
                "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n"
            );
            var configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(f.Data, f.Temp.Path, environment: _ => null)
            );
            var models = new HostModels(configuration);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new(f.Data, f.Work, options, models);
            await f.Manager.LoadAsync();
            f.Owner = await f.Manager.CreateNamedAsync("main", "provider", null, null);
            f.mcp = new(f.Data);
            var definitions = WorkspaceTools.Definitions();
            foreach (
                var item in FileDeliveryDefinitions
                    .Definitions()
                    .Concat(NodeToolDefinitions.All())
                    .Concat(LocalExecManager.Definitions())
                    .Concat(ToolScriptToolDefinitions.Definitions())
                    .Concat(UnifiedToolDefinitions.All())
            )
                definitions.Add(item?.DeepClone());
            f.Registry = SessionToolExecutor.CreateRegistry(
                definitions,
                f.mcp,
                _ => f.Work,
                f.Manager.Nodes,
                f.Manager.NodeProviders
            );
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

        internal string FilePath(string relative) => Path.Combine(Target, "fs", "root", relative);

        internal async Task Seed(string relative, byte[] bytes)
        {
            var path = FilePath(relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllBytesAsync(path, bytes);
        }

        internal async Task<JsonObject[]> Requests() =>
            (await File.ReadAllLinesAsync(Path.Combine(Target, "calls.jsonl")))
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .ToArray();

        public async ValueTask DisposeAsync()
        {
            if (mcp is not null)
                await mcp.DisposeAsync();
            if (Manager is not null)
                await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static JsonObject Args(string path) => new() { ["filePath"] = path };

    private static void Success(JsonObject value) => Assert.Null(value["error"]);

    [Fact]
    public async Task Selected_direct_qualified_unified_and_programmatic_tools_share_canonical_semantics_and_opaque_paths()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        Assert.Equal(
            "opaque://root",
            (await f.Manager.SelectNodeAsync(f.Owner, f.Node))["defaultCwd"]!.GetValue<string>()
        );
        Success(
            await f.Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "nested/text.txt",
                    ["content"] = "alpha\r\nβeta\r\ngamma\n",
                    ["createDirs"] = true,
                }
            )
        );
        var read = await f.Call(
            "read",
            new JsonObject
            {
                ["filePath"] = "opaque://root/nested/text.txt",
                ["startLine"] = 2,
                ["endLine"] = 2,
            }
        );
        Success(read);
        Assert.StartsWith("βeta\r\n", read["output"]!.GetValue<string>());
        Success(
            await f.Call(
                "call_tool",
                new JsonObject
                {
                    ["toolId"] = "node:" + f.Node + "/edit",
                    ["args"] = new JsonObject
                    {
                        ["filePath"] = "nested/text.txt",
                        ["oldText"] = "βeta",
                        ["newText"] = "δelta",
                    },
                }
            )
        );
        Assert.Contains("δelta", await File.ReadAllTextAsync(f.FilePath("nested/text.txt")));
        var patch =
            "*** Begin Patch\n*** Add File: other/new.txt\n+created\n*** Update File: nested/text.txt\n@@\n-alpha\n+first\n*** End Patch";
        Success(await f.Call("apply_patch", new JsonObject { ["input"] = patch }));
        Assert.Contains("first", await File.ReadAllTextAsync(f.FilePath("nested/text.txt")));
        var listing = await f.Call("read", Args("opaque://root/nested"));
        Success(listing);
        Assert.Contains("text.txt", listing["output"]!.GetValue<string>());
        var native = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('node:"
                    + f.Node
                    + "/read', {'filePath':'nested/text.txt'})['content']",
            }
        );
        Success(native);
        Assert.Contains("δelta", native["result"]!.GetValue<string>());
        var search = await f.Call(
            "search_tools",
            new JsonObject { ["sources"] = new JsonArray("node"), ["nodeId"] = f.Node }
        );
        Success(search);
        Assert.Contains(f.Node, search["output"]!.GetValue<string>());
        Success(
            await f.Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "C:\\work\\exact.txt",
                    ["content"] = "windows-owned",
                    ["createDirs"] = true,
                }
            )
        );
        Assert.Equal(
            "windows-owned",
            await File.ReadAllTextAsync(
                Path.Combine(f.Target, "fs", "windows", "C", "work", "exact.txt")
            )
        );
        var requests = await f.Requests();
        Assert.Contains(
            requests,
            call => call["request"]?["path"]?.GetValue<string>() == "C:\\work\\exact.txt"
        );
        Assert.All(
            requests.Where(call => call["operation"]!.GetValue<string>() == "filesystem"),
            call =>
            {
                var body = call["request"]!.AsObject();
                Assert.DoesNotContain("sourceSessionId", body.Select(pair => pair.Key));
                Assert.DoesNotContain(
                    "agent",
                    body["context"]!.AsObject().Select(pair => pair.Key)
                );
                Assert.DoesNotContain('/', body["nodeId"]!.GetValue<string>());
            }
        );
        Assert.False(File.Exists(Path.Combine(f.Work, "nested", "text.txt")));
    }

    [Fact]
    public async Task Provider_directory_preserves_nonregular_entry_kind_without_file_size()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        await f.Seed("directory/plain.txt", Encoding.UTF8.GetBytes("ordinary"));
        using (
            var process = System.Diagnostics.Process.Start(
                "mkfifo",
                new[] { f.FilePath("directory/pipe") }
            )!
        )
        {
            await process.WaitForExitAsync();
            Assert.Equal(0, process.ExitCode);
        }
        var result = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "node:" + f.Node + "/read", ["args"] = Args("directory") }
        );
        Success(result);
        var output = result["output"]!.GetValue<string>();
        Assert.Contains("`pipe` (other)", output);
        Assert.Contains("`plain.txt` (file, 8 B)", output);
    }

    [Fact]
    public async Task Retry_refs_parent_errors_capability_denial_and_partial_patch_do_not_replay_or_fall_back()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        var missing = await f.Call(
            "write",
            new JsonObject { ["filePath"] = "missing/file", ["content"] = "remembered" }
        );
        Assert.NotNull(missing["error"]);
        var reference = System
            .Text.RegularExpressions.Regex.Match(missing.ToJsonString(), "write_[0-9a-f]+")
            .Value;
        Assert.NotEmpty(reference);
        Success(
            await f.Call(
                "write",
                new JsonObject
                {
                    ["filePath"] = "missing/file",
                    ["contentRef"] = reference,
                    ["overwrite"] = true,
                    ["createDirs"] = true,
                }
            )
        );
        Assert.Equal("remembered", await File.ReadAllTextAsync(f.FilePath("missing/file")));
        var denied = await f.Call(
            "write",
            new JsonObject
            {
                ["filePath"] = "denied/file",
                ["content"] = "no",
                ["createDirs"] = true,
            }
        );
        Assert.Contains("denied", denied.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("missing_parent", denied.ToJsonString());
        var prior = (await f.Requests()).Length;
        Assert.NotNull(
            (
                await f.Call(
                    "write",
                    new JsonObject { ["filePath"] = "$fw_tmp/file", ["content"] = "no" }
                )
            )["error"]
        );
        Assert.DoesNotContain(
            (await f.Requests()).Skip(prior),
            call => call["operation"]!.GetValue<string>() == "filesystem"
        );
        var partial = await f.Call(
            "apply_patch",
            new JsonObject
            {
                ["input"] =
                    "*** Begin Patch\n*** Add File: partial.txt\n+retained\n*** Delete File: absent.txt\n*** Add File: never.txt\n+never\n*** End Patch",
            }
        );
        Assert.NotNull(partial["error"]);
        Assert.Contains("already applied", partial.ToJsonString());
        Assert.True(File.Exists(f.FilePath("partial.txt")));
        Assert.False(File.Exists(f.FilePath("never.txt")));
        Assert.DoesNotContain(
            await f.Requests(),
            call =>
                call["request"]?["operation"]?.GetValue<string>() == "remove"
                && call["request"]?["path"]?.GetValue<string>() == "absent.txt"
        );
        var readonlyCall = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["toolId"] = "node:fixture/readonly/write",
                ["args"] = new JsonObject { ["filePath"] = "no.txt", ["content"] = "no" },
            }
        );
        Assert.NotNull(readonlyCall["error"]);
        Assert.False(File.Exists(Path.Combine(f.Work, "no.txt")));
        Assert.False(f.Manager.NodeProviders.Online("fixture/offline"));
    }

    [Fact]
    public async Task Binary_empty_and_large_transfers_use_bounded_chunks_and_leave_failed_append_prefix()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        var bytes = Enumerable
            .Range(0, 5 * 1024 * 1024 + 123)
            .Select(index => (byte)(index * 17))
            .ToArray();
        await File.WriteAllBytesAsync(
            Path.Combine(f.Manager.AgentDirectory("main"), "source.bin"),
            bytes
        );
        var copy = new JsonObject
        {
            ["sourceNode"] = "master",
            ["sourcePath"] = "source.bin",
            ["targetNode"] = f.Node,
            ["targetPath"] = "binary.bin",
        };
        Success(await f.Manager.CopyBetweenNodesAsync(f.Owner, copy, default));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(f.FilePath("binary.bin")));
        var reverse = new JsonObject
        {
            ["sourceNode"] = f.Node,
            ["sourcePath"] = "binary.bin",
            ["targetNode"] = "master",
            ["targetPath"] = "received.bin",
        };
        Success(await f.Manager.CopyBetweenNodesAsync(f.Owner, reverse, default));
        Assert.Equal(
            bytes,
            await File.ReadAllBytesAsync(
                Path.Combine(f.Manager.AgentDirectory("main"), "received.bin")
            )
        );
        var across = new JsonObject
        {
            ["sourceNode"] = f.Node,
            ["sourcePath"] = "binary.bin",
            ["targetNode"] = "other/target",
            ["targetPath"] = "cross-provider.bin",
        };
        Success(await f.Manager.CopyBetweenNodesAsync(f.Owner, across, default));
        Assert.Equal(
            bytes,
            await File.ReadAllBytesAsync(
                Path.Combine(f.OtherTarget, "fs", "root", "cross-provider.bin")
            )
        );
        var files = new WorkspaceTools(f.Work);
        await f.Manager.WriteNodeFileAsync(f.Owner, f.Node, "empty", [], false, files, default);
        Assert.Empty(await File.ReadAllBytesAsync(f.FilePath("empty")));
        Assert.Empty(
            (await f.Manager.ReadNodeFileAsync(f.Owner, f.Node, "empty", files, default)).Bytes
        );
        await File.WriteAllTextAsync(Path.Combine(f.Target, "fail-append"), "fail");
        await Assert.ThrowsAsync<NodeProviderException>(() =>
            f.Manager.WriteNodeFileAsync(f.Owner, f.Node, "prefix", bytes, false, files, default)
        );
        Assert.Equal(bytes[..(1024 * 1024)], await File.ReadAllBytesAsync(f.FilePath("prefix")));
        var requests = await f.Requests();
        Assert.All(
            requests.Where(call => call["request"]?["operation"]?.GetValue<string>() == "read"),
            call => Assert.Equal(1024 * 1024, call["request"]!["count"]!.GetValue<int>())
        );
        Assert.All(
            requests.Where(call => call["writeBytes"] is not null),
            call => Assert.InRange(call["writeBytes"]!.GetValue<int>(), 0, 1024 * 1024)
        );
        Assert.Single(
            requests,
            call =>
                call["request"]?["path"]?.GetValue<string>() == "prefix"
                && call["request"]?["flag"]?.GetValue<string>() == "wx"
        );
    }
}
