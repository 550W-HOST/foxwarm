using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class NodePrivateCredentialTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        private Foxwarm.McpClient mcp = null!;

        internal string PathFor(string name) => Path.Combine(Temp.Path, name);

        internal async Task Start(JsonObject? isolation = null)
        {
            var data = PathFor("data");
            if (isolation is not null)
            {
                Directory.CreateDirectory(Path.Combine(data, "state"));
                await File.WriteAllTextAsync(
                    Path.Combine(data, "state", "agents.json"),
                    new JsonObject
                    {
                        ["version"] = 2,
                        ["agents"] = new JsonArray(),
                        ["metadata"] = new JsonObject { ["main"] = isolation },
                    }.ToJsonString()
                );
            }
            Manager = new(data, PathFor("work"), Options, HostModels.ForTest(Options));
            await Manager.LoadAsync();
            if (isolation is not null)
                Manager.Nodes.Registry.Create("bound");
            Owner = await Manager.CreateNamedAsync("main", "credential-owner", null, null);
            mcp = new(data);
            var registry = SessionToolExecutor.CreateRegistry(
                NodeToolDefinitions.All(),
                mcp,
                _ => PathFor("work"),
                Manager.Nodes
            );
            Tools = new(new WorkspaceTools(PathFor("work")), Owner, Manager, registry);
            Tools.BeginTurn();
        }

        internal async Task<JsonObject> Call(
            string id,
            string path,
            CancellationToken token = default
        ) =>
            (
                await Tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "private-file",
                        ["name"] = "call_tool",
                        ["args"] = new JsonObject
                        {
                            ["toolId"] = "builtin:node_create_auth_token",
                            ["args"] = new JsonObject { ["nodeId"] = id, ["filePath"] = path },
                        },
                    },
                    token
                )
            )!.AsObject();

        internal void RegistryWrite(Action<AtomicJsonWriteStage>? hook)
        {
            var file = typeof(ApprovedNodeRegistry)
                .GetField("file", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(Manager.Nodes.Registry)!;
            typeof(LinuxAtomicJsonFile)
                .GetField("stageHook", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(file, hook);
        }

        public async ValueTask DisposeAsync()
        {
            if (mcp is not null)
                await mcp.DisposeAsync();
            if (Manager is not null)
                await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Main_private_effect_uses_new_exclusive_file_and_registry_even_with_remote_placement()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        await fixture.Owner.Entry.SaveLane.CommitNodeAsync("remote-offline");
        await fixture.Owner.UpdateCwdAsync("/remote/not-main");
        var path = fixture.PathFor("credential");
        var result = await fixture.Call("owned", path);
        Assert.Null(result["error"]);
        Assert.Equal("owned", result["nodeId"]!.GetValue<string>());
        Assert.Equal(path, result["filePath"]!.GetValue<string>());
        var contents = await File.ReadAllTextAsync(path);
        Assert.EndsWith("\n", contents);
        Assert.True(fixture.Manager.Nodes.Registry.Authenticate("owned", contents.Trim()));
        Assert.DoesNotContain(contents.Trim(), result.ToJsonString());
        if (!OperatingSystem.IsWindows())
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(path)
            );
        var duplicateId = fixture.PathFor("duplicate-id");
        Assert.NotNull((await fixture.Call("owned", duplicateId))["error"]);
        Assert.False(File.Exists(duplicateId));
        Assert.NotNull((await fixture.Call("different", path))["error"]);
        Assert.Equal(contents, await File.ReadAllTextAsync(path));
        var link = fixture.PathFor("link");
        File.CreateSymbolicLink(link, fixture.PathFor("absent-target"));
        Assert.NotNull((await fixture.Call("link-node", link))["error"]);
        Assert.False(File.Exists(fixture.PathFor("absent-target")));
        Assert.NotNull(new FileInfo(link).LinkTarget);
        Assert.NotNull((await fixture.Call("relative", "relative-token"))["error"]);
        Assert.NotNull(
            (await fixture.Call("no-parent", fixture.PathFor("absent-parent/token")))["error"]
        );
        Assert.Single(fixture.Manager.Nodes.Registry.ListApproved());
    }

    [Fact]
    public async Task Main_policy_and_exact_isolation_grant_cannot_be_replaced_by_remote_authority()
    {
        await using var fixture = new Fixture();
        await fixture.Start(
            new JsonObject
            {
                ["isolated"] = true,
                ["isolatedNode"] = "bound",
                ["toolRules"] = new JsonArray(
                    new JsonObject
                    {
                        ["source"] = "builtin",
                        ["tool"] = "node_create_auth_token",
                        ["effect"] = "allow",
                    }
                ),
            }
        );
        var outside = fixture.PathFor("outside");
        Assert.Equal(
            "tool_authorization_denied",
            (await fixture.Call("outside", outside))["error"]?["type"]?.GetValue<string>()
        );
        Assert.False(File.Exists(outside));
        var allowed = fixture.PathFor("work/allowed");
        await fixture.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules:\n  - id: credential-path\n    action: deny\n    match:\n      tool: {source: builtin, name: node_create_auth_token}\n      path: {allWithin: "
                    + allowed
                    + "}\n"
            ),
            default
        );
        Assert.Equal(
            "tool_authorization_denied",
            (await fixture.Call("denied", allowed))["error"]?["type"]?.GetValue<string>()
        );
        Assert.False(File.Exists(allowed));
        await fixture.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\n"),
            default
        );
        Assert.Null((await fixture.Call("allowed", allowed))["error"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Registry_failure_cleans_file_and_reports_committed_reservation_truth(
        bool committed
    )
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        var path = fixture.PathFor("credential");
        fixture.RegistryWrite(stage =>
        {
            if (
                stage
                == (
                    committed
                        ? AtomicJsonWriteStage.AfterDirectorySync
                        : AtomicJsonWriteStage.BeforeRename
                )
            )
                throw new IOException("owned registry persistence failure");
        });
        var result = await fixture.Call("reserved", path);
        fixture.RegistryWrite(null);
        Assert.NotNull(result["error"]);
        Assert.False(File.Exists(path));
        Assert.Equal(committed ? 1 : 0, fixture.Manager.Nodes.Registry.ListApproved().Count);
        if (committed)
            Assert.Contains("remains reserved", result.ToJsonString());
    }

    [Fact]
    public async Task Failed_write_after_real_reservation_retains_node_and_reports_cleaned_file()
    {
        await using var fixture = new Fixture();
        await fixture.Start();
        using var stop = new CancellationTokenSource();
        fixture.RegistryWrite(stage =>
        {
            if (stage == AtomicJsonWriteStage.AfterDirectorySync)
                stop.Cancel();
        });
        var path = fixture.PathFor("credential");
        var result = await fixture.Call("reserved", path, stop.Token);
        fixture.RegistryWrite(null);
        Assert.Contains("remains reserved", result.ToJsonString());
        Assert.Contains("was cleaned", result.ToJsonString());
        Assert.False(File.Exists(path));
        Assert.Single(fixture.Manager.Nodes.Registry.ListApproved());
    }
}
