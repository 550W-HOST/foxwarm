using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    [Fact]
    public async Task Unadmitted_provider_discovery_cannot_read_or_execute_during_a_lifecycle_receipt_while_inspection_and_known_targets_remain_available()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var reader = await f.Child();
        var root = Path.Combine(f.Target, "fs", "root");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, "secret.txt"), "subtree-protected-content");
        await f.Policy(
            """
            version: 1
            rules:
            - {tool: [read, exec], node: {exact: fixture/target}, action: allow}
            - {tool: [read, exec], node: parent, action: deny}
            """
        );
        var args = Lifecycle("create", "fixture/newcomer");
        args["parameters"] = Obj("""{"block":true}""");
        var creation = f.Call("node", args);
        var read = Obj(
            """{"toolId":"node:fixture/newcomer/read","args":{"filePath":"secret.txt"}}"""
        );
        var exec = Obj(
            """{"toolId":"node:fixture/newcomer/exec","args":{"command":"printf ran > race-exec.txt; printf subtree-exec-proof","timeout":1}}"""
        );
        try
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            while (!File.Exists(Path.Combine(f.Target, "effect-started")))
                await Task.Delay(10, deadline.Token);
            Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/newcomer"));
            // List, direct capability refresh, and read-only inspect all observe the real environment.
            // None may publish executable capabilities without its admitted authorization ancestry.
            Success(
                await f.Call("node", Obj("""{"action":"list"}"""), reader)
                    .WaitAsync(TimeSpan.FromSeconds(2))
            );
            var inspected = await f.Call(
                    "node",
                    Obj("""{"action":"inspect","nodeId":"fixture/newcomer"}"""),
                    reader
                )
                .WaitAsync(TimeSpan.FromSeconds(2));
            Success(inspected);
            Assert.Empty(inspected!["node"]!["tools"]!.AsArray());
            var deniedRead = await f.Call("call_tool", read, reader);
            Denied(deniedRead);
            Assert.DoesNotContain("subtree-protected-content", deniedRead!.ToJsonString());
            var deniedExec = await f.Call("call_tool", exec, reader);
            Denied(deniedExec);
            Assert.DoesNotContain("subtree-exec-proof", deniedExec!.ToJsonString());
            Assert.False(File.Exists(Path.Combine(root, "race-exec.txt")));
            var copy = new JsonObject
            {
                ["sourceNode"] = "fixture/newcomer",
                ["sourcePath"] = "secret.txt",
                ["targetNode"] = "master",
                ["targetPath"] = Path.Combine(f.Work, "unadmitted-copy.txt"),
            };
            Denied(await f.Call("copy_between_nodes", copy, reader));
            Assert.False(File.Exists(Path.Combine(f.Work, "unadmitted-copy.txt")));
            Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/newcomer"));
            // Both actual file contents and an actual command effect remain available on a known,
            // independently permitted endpoint while the other identity's receipt is blocked.
            var knownRead = await f.Call(
                "call_tool",
                Obj("""{"toolId":"node:fixture/target/read","args":{"filePath":"secret.txt"}}"""),
                reader
            );
            Success(knownRead);
            Assert.Contains("subtree-protected-content", knownRead!.ToJsonString());
            Success(
                await f.Call(
                    "call_tool",
                    Obj(
                        """{"toolId":"node:fixture/target/exec","args":{"command":"printf permitted > admitted-control.txt","timeout":1}}"""
                    ),
                    reader
                )
            );
            Assert.Equal(
                "permitted",
                await File.ReadAllTextAsync(Path.Combine(root, "admitted-control.txt"))
            );
            Assert.False(creation.IsCompleted);
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(f.Target, "release-effect"), "");
        }
        Success(await creation);
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/newcomer"));
        var afterRead = await f.Call("call_tool", read, reader);
        Denied(afterRead);
        Assert.DoesNotContain("subtree-protected-content", afterRead!.ToJsonString());
        Denied(await f.Call("call_tool", exec, reader));
        Assert.False(File.Exists(Path.Combine(root, "race-exec.txt")));
        await f.Policy("version: 1\nrules: []\n");
        var permittedRead = await f.Call("call_tool", read, reader);
        Success(permittedRead);
        Assert.Contains("subtree-protected-content", permittedRead!.ToJsonString());
        var permittedExec = await f.Call("call_tool", exec, reader);
        Success(permittedExec);
        Assert.Contains("subtree-exec-proof", permittedExec!.ToJsonString());
        Assert.Equal("ran", await File.ReadAllTextAsync(Path.Combine(root, "race-exec.txt")));
        Assert.Single(await f.Effects());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task First_explicit_existing_ensure_uses_its_exact_identity_grant_without_manual_inventory_and_fresh_ensure_still_requires_its_parent(
        bool unified
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create(provider: true);
        var delegated = await f.Child();
        await f.Policy(
            """
            version: 1
            rules:
            - {tool: node, args: {action: ensure}, node: {exact: fixture/target}, action: allow}
            - {tool: node, args: {action: ensure}, action: deny}
            """
        );
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/target"));
        var ensure = Lifecycle("ensure", "fixture/target");
        var result = unified
            ? await f.Call(
                "call_tool",
                new JsonObject { ["toolId"] = "builtin:node", ["args"] = ensure },
                delegated
            )
            : await f.Call("node", ensure, delegated);
        Success(result);
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/target"));
        Assert.Single(await f.Effects());
        Assert.Equal("ensure", (await f.Effects())[0]["operation"]!.GetValue<string>());
        Denied(await f.Call("node", Lifecycle("ensure", "fixture/fresh"), delegated));
        Assert.Single(await f.Effects());
        Assert.False(f.Manager.Nodes.Registry.Forest().Contains("fixture/fresh"));
        await f.Manager.SetAgentRulesAsync(
            "main",
            Rules(
                """[{"tool":"node","args":{"action":"ensure"},"node":{"exact":"fixture/target"},"action":"deny"}]"""
            )
        );
        Denied(await f.Call("node", ensure, delegated));
        Assert.Single(await f.Effects());
        await f.Manager.SetAgentRulesAsync("main", new JsonArray());
        await f.Policy(
            """
            version: 1
            rules:
            - {tool: node, args: {action: ensure}, node: parent, action: allow}
            - {tool: node, args: {action: ensure}, action: deny}
            """
        );
        Success(await f.Call("node", Lifecycle("ensure", "fixture/fresh"), delegated));
        Assert.Equal(2, (await f.Effects()).Length);
        Assert.Equal("parent", f.Manager.Nodes.Registry.Forest().Parent("fixture/fresh"));
    }
}
