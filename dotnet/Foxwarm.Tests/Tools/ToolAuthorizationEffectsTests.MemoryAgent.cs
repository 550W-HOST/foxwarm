using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// The memory tools' agentName argument: another Agent's memory directory, authorized as an
// ordinary master read or write of the resolved file, through real dispatch.
public sealed partial class ToolAuthorizationEffectsTests
{
    private sealed record MemoryWorld(
        SessionManager Manager,
        SessionOwner Owner,
        SessionToolExecutor Tools,
        WorkspaceTools Files,
        Foxwarm.McpClient Mcp,
        ToolRegistry Registry,
        string Own,
        string Other
    );

    private static async Task<MemoryWorld> MemoryAgents(TempDirectory temp)
    {
        await Seed(temp.Path);
        var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("alpha", "memory-caller", null, null);
        var execution = TimerExecutor(manager, owner, temp.Path, MainLocalToolDefinitions.Definitions());
        var own = AuthorizationPaths.CanonicalPotential(Path.Combine(manager.AgentDirectory("alpha"), "memory"));
        var other = AuthorizationPaths.CanonicalPotential(Path.Combine(manager.AgentDirectory("beta"), "memory"));
        await File.WriteAllTextAsync(Path.Combine(own, "own.md"), "own memory");
        await File.WriteAllTextAsync(Path.Combine(other, "other.md"), "other memory");
        return new(manager, owner, execution.Tools, execution.Files, execution.Mcp, execution.Registry, own, other);
    }

    private static Task<JsonObject> Memory(MemoryWorld world, string tool, string arguments) =>
        Call(world.Tools, tool, Obj(arguments));

    private static string? Output(JsonObject response) => SessionWait.Text(response["output"]);

    [Fact]
    public async Task Memory_tools_act_on_the_named_Agent_and_say_which()
    {
        using var temp = new TempDirectory();
        var world = await MemoryAgents(temp);
        await using var manager = world.Manager;
        await using var mcp = world.Mcp;
        // Omitted: the caller's own Agent, reply unchanged.
        var own = await Memory(world, "edit_memory", """{"filePath":"own.md","oldText":"own","newText":"mine"}""");
        Assert.Null(Error(own));
        Assert.Equal("Memory file edited: own.md", Output(own));
        Assert.Equal("mine memory", await File.ReadAllTextAsync(Path.Combine(world.Own, "own.md")));
        Assert.Equal("other memory", await File.ReadAllTextAsync(Path.Combine(world.Other, "other.md")));
        // Named: the other Agent's file changes and the reply names the Agent.
        var edited = await Memory(
            world,
            "edit_memory",
            """{"agentName":"beta","filePath":"other.md","oldText":"other","newText":"changed"}"""
        );
        Assert.Null(Error(edited));
        Assert.Equal("Memory file edited: other.md (Agent beta)", Output(edited));
        Assert.Equal("changed memory", await File.ReadAllTextAsync(Path.Combine(world.Other, "other.md")));
        Assert.Equal("mine memory", await File.ReadAllTextAsync(Path.Combine(world.Own, "own.md")));
        // The own Agent may be named too.
        Assert.Equal(
            "Memory file edited: own.md (Agent alpha)",
            Output(await Memory(world, "edit_memory", """{"agentName":"alpha","filePath":"own.md","oldText":"mine","newText":"own"}"""))
        );
        var written = await Memory(world, "write_memory", """{"agentName":"beta","filePath":"notes/new.md","content":"new"}""");
        Assert.Equal("Memory file created: notes/new.md (Agent beta)", Output(written));
        Assert.True(File.Exists(Path.Combine(world.Other, "notes", "new.md")));
        Assert.False(File.Exists(Path.Combine(world.Own, "notes", "new.md")));
        Assert.Contains(
            "changed",
            Output(await Memory(world, "read_memory", """{"agentName":"beta","filePath":"other.md"}"""))
        );
        var patched = await Memory(
            world,
            "apply_patch_memory",
            """{"agentName":"beta","input":"*** Begin Patch\n*** Add File: notes/patched.md\n+patched\n*** End Patch"}"""
        );
        Assert.StartsWith("Patch applied successfully (Agent beta).\n", Output(patched));
        Assert.True(File.Exists(Path.Combine(world.Other, "notes", "patched.md")));
        var deleted = await Memory(world, "delete_memory", """{"agentName":"beta","filePath":"notes/new.md"}""");
        Assert.Equal("Deleted memory file `notes/new.md` (Agent beta)", Output(deleted));
        Assert.False(File.Exists(Path.Combine(world.Other, "notes", "new.md")));
        // A null argument is an omitted one.
        Assert.Equal(
            "Memory file created: null.md",
            Output(await Memory(world, "write_memory", """{"agentName":null,"filePath":"null.md","content":"x"}"""))
        );
        Assert.True(File.Exists(Path.Combine(world.Own, "null.md")));
    }

    [Theory]
    [InlineData("""{"agentName":"nobody","filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":" beta ","filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":"","filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":"../beta","filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":"alpha/../beta","filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":7,"filePath":"x.md","content":"x"}""")]
    [InlineData("""{"agentName":"beta","filePath":"../alpha/memory/x.md","content":"x"}""")]
    [InlineData("""{"agentName":"beta","filePath":"../../../escaped.md","content":"x"}""")]
    [InlineData("""{"agentName":"beta","filePath":"memory/../../x.md","content":"x"}""")]
    public async Task Memory_tools_reject_unknown_Agents_and_traversal(string arguments)
    {
        using var temp = new TempDirectory();
        var world = await MemoryAgents(temp);
        await using var manager = world.Manager;
        await using var mcp = world.Mcp;
        string[] Files() => Directory.EnumerateFiles(temp.Path, "*", SearchOption.AllDirectories).Order().ToArray();
        var before = Files();
        Assert.NotNull(Error(await Memory(world, "write_memory", arguments)));
        Assert.Equal(before, Files());
    }

    [Fact]
    public async Task Memory_tool_facts_name_the_resolved_file_of_the_target_Agent()
    {
        using var temp = new TempDirectory();
        var world = await MemoryAgents(temp);
        await using var manager = world.Manager;
        await using var mcp = world.Mcp;
        await Policy(manager, OperationEffectConformance.Policy);
        async Task<string?> Resolved(string arguments)
        {
            var assessment = await manager.AssessToolAsync(
                world.Owner,
                world.Registry.Resolve("write_memory", Obj(arguments)),
                world.Files,
                default
            );
            return Assert
                .Single(assessment.Request.Operations ?? [], operation => operation.Op == "env.write")
                .Path!.Resolved;
        }
        Assert.Equal(Path.Combine(world.Other, "x.md"), await Resolved("""{"agentName":"beta","filePath":"x.md","content":"x"}"""));
        Assert.Equal(Path.Combine(world.Other, "x.md"), await Resolved("""{"agentName":"beta","filePath":"memory/x.md","content":"x"}"""));
        Assert.Equal(Path.Combine(world.Own, "x.md"), await Resolved("""{"filePath":"x.md","content":"x"}"""));
        Assert.Equal(Path.Combine(world.Own, "x.md"), await Resolved("""{"agentName":"alpha","filePath":"x.md","content":"x"}"""));
        // The canonical physical directory, as a copy leg reads it.
        Assert.Equal(
            Path.Combine(AuthorizationPaths.CanonicalPotential(manager.MemoryDirectory("beta")), "x.md"),
            await Resolved("""{"agentName":"beta","filePath":"x.md","content":"x"}""")
        );
    }

    // An allow or deny rule on the other Agent's memory path decides; nothing else is required.
    [Fact]
    public async Task Memory_paths_of_another_Agent_are_decided_by_path_rules()
    {
        using var temp = new TempDirectory();
        var world = await MemoryAgents(temp);
        await using var manager = world.Manager;
        await using var mcp = world.Mcp;
        const string edit = """{"agentName":"beta","filePath":"other.md","oldText":"other","newText":"edited"}""";
        const string ownEdit = """{"filePath":"own.md","oldText":"own","newText":"edited"}""";
        const string read = """{"agentName":"beta","filePath":"other.md"}""";
        const string create = """{"agentName":"beta","filePath":"n.md","content":"x"}""";
        const string denied = "tool_authorization_denied";
        // A deny of the other Agent's memory blocks only that.
        await Policy(manager, "version: 1\nrules:\n- {id: no-beta, op: env.write, path: {within: '" + world.Other + "'}, action: deny}\n");
        Assert.Equal(denied, Error(await Memory(world, "edit_memory", edit)));
        Assert.Equal("other memory", await File.ReadAllTextAsync(Path.Combine(world.Other, "other.md")));
        Assert.Null(Error(await Memory(world, "read_memory", read)));
        Assert.Null(Error(await Memory(world, "edit_memory", ownEdit)));
        // Only an allow for the other Agent's memory permits the write.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {id: beta-write, op: env.write, path: {within: '" + world.Other + "'}, action: allow}\n"
        );
        Assert.Null(Error(await Memory(world, "edit_memory", edit)));
        Assert.Equal("edited memory", await File.ReadAllTextAsync(Path.Combine(world.Other, "other.md")));
        Assert.Equal(denied, Error(await Memory(world, "write_memory", """{"filePath":"own-new.md","content":"x"}""")));
        // A read allow does not cover a write.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {id: beta-read, op: env.read, path: {within: '" + world.Other + "'}, action: allow}\n"
        );
        Assert.Null(Error(await Memory(world, "read_memory", read)));
        Assert.Equal(denied, Error(await Memory(world, "write_memory", create)));
        // A denied master write blocks the call wherever it points.
        await Policy(manager, "version: 1\nrules:\n- {id: no-master-writes, op: env.write, node: master, action: deny}\n");
        Assert.Equal(denied, Error(await Memory(world, "write_memory", create)));
        Assert.Equal(denied, Error(await Memory(world, "edit_memory", edit)));
        Assert.False(File.Exists(Path.Combine(world.Other, "n.md")));
        // Version-1 rules naming the tool keep matching, and their path selectors see the path.
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n- {id: v1, action: deny, match: {tool: {source: builtin, name: write_memory}}}\n"
        );
        Assert.Equal(denied, Error(await Memory(world, "write_memory", create)));
        await Policy(
            manager,
            "version: 1\ndefaultAction: allow\nrules:\n- {id: v1-path, action: deny, match: {tool: {source: builtin, name: write_memory}, path: {allWithin: '" + world.Other + "'}}}\n"
        );
        Assert.Equal(denied, Error(await Memory(world, "write_memory", create)));
        Assert.Null(Error(await Memory(world, "write_memory", """{"filePath":"own-new.md","content":"x"}""")));
    }
}
