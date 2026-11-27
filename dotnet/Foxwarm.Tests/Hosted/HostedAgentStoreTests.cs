using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The consumers of the hosted Agent store: a runtime without a master Node whose storage has
/// an Agent store keeps its Agents there. Memory tools return what they return over Agent
/// folders, the composed prompt is byte-identical, the Agent lifecycle writes the store and
/// nothing else, skills load and run from it, and path rules decide store paths.
/// </summary>
[Trait("Backend", "postgres")]
public sealed partial class HostedAgentStoreTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    // A hosted fixture over a tenant database with its Agent store, or over Agent folders.
    internal sealed class StoreFixture : IAsyncDisposable
    {
        internal HostedCapabilityProfileTests.Fixture Inner = null!;
        internal HostedTestDatabase? Database;
        internal IStorageContext? Storage;
        internal PostgresStorageContext? Postgres;

        internal IAgentStore Store => Storage!.AgentFiles!;

        internal SessionManager Manager => Inner.Manager;

        internal static async Task<StoreFixture> Create(
            bool store,
            JsonObject? extraApp = null,
            bool installedLayout = false,
            // The Agent metadata document before startup.
            string? agents = null,
            Func<HostPaths, ModelConfiguration>? configuration = null
        )
        {
            var fixture = new StoreFixture();
            Func<string, IStorageContext>? storage = null;
            if (store)
            {
                var (database, tenant) = await PostgresAgentFilesTests.OpenAsync();
                fixture.Database = database;
                storage = root =>
                {
                    fixture.Storage = HostedTestBackend.Compose(
                        fixture.Postgres = new PostgresStorageContext(tenant, root)
                        {
                            KeyRing = new HostedKeyRing(tenant, HostedTestBackend.Kek),
                        },
                        root
                    );
                    if (agents is not null)
                        fixture.Storage.Documents.Open(StateDocumentName.Agents).ReplaceText(agents);
                    return fixture.Storage;
                };
            }
            fixture.Inner = await HostedCapabilityProfileTests.Fixture.Create(
                RuntimeCapabilities.Hosted,
                extraApp: extraApp,
                storage: storage,
                installedLayout: installedLayout,
                configuration: configuration
            );
            return fixture;
        }

        internal Task<JsonObject> Call(string name, JsonObject args, SessionToolExecutor? tools = null) =>
            Inner.Call(name, args, tools);

        public async ValueTask DisposeAsync()
        {
            await Inner.DisposeAsync();
            if (Database is not null)
                await Database.DisposeAsync();
        }
    }

    // A result as a model sees it, with folder paths and listing times taken out: file mode's
    // .NET texts name the physical memory directory, where the store names the memory path.
    private static string Seen(JsonObject result, SessionManager manager)
    {
        var text = result.FailureMessage() is { } failure
            ? "ERROR " + failure
            : SessionWait.Text(result["output"]) ?? result.ToJsonString();
        if (manager.AgentStore is null)
            foreach (var agent in manager.Agents())
                text = text
                    .Replace(manager.MemoryDirectory(agent) + "/", "", StringComparison.Ordinal)
                    .Replace("'" + manager.MemoryDirectory(agent) + "'", "'.'", StringComparison.Ordinal);
        return Regex.Replace(text, @"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", "<time>");
    }

    private static readonly (string Tool, JsonObject Args)[] MemoryScript =
    [
        ("write_memory", new() { ["filePath"] = "NOTES.md", ["content"] = "one\ntwo\n" }),
        ("write_memory", new() { ["filePath"] = "NOTES.md", ["content"] = "again" }),
        ("read_memory", new() { ["filePath"] = "NOTES.md" }),
        ("read_memory", new() { ["filePath"] = "memory/NOTES.md", ["startLine"] = 2 }),
        ("write_memory", new() { ["filePath"] = "/sub/deep/a.md", ["content"] = "A" }),
        ("write_memory", new() { ["filePath"] = "sub/b.md", ["content"] = "Bee" }),
        ("read_memory", new() { ["filePath"] = "sub" }),
        ("read_memory", new() { ["filePath"] = "sub/deep" }),
        ("edit_memory", new() { ["filePath"] = "NOTES.md", ["oldText"] = "two", ["newText"] = "three" }),
        ("edit_memory", new() { ["filePath"] = "NOTES.md", ["oldText"] = "missing", ["newText"] = "x" }),
        ("edit_memory", new() { ["filePath"] = "NOTES.md", ["oldText"] = "", ["newText"] = "zero\n" }),
        ("edit_memory", new() { ["filePath"] = "nope.md", ["oldText"] = "x", ["newText"] = "y" }),
        ("edit_memory", new() { ["filePath"] = "sub", ["oldText"] = "x", ["newText"] = "y" }),
        ("delete_memory", new() { ["filePath"] = "sub" }),
        ("delete_memory", new() { ["filePath"] = "gone.md" }),
        ("write_memory", new() { ["filePath"] = "NOTES.md/x.md", ["content"] = "x" }),
        ("read_memory", new() { ["filePath"] = "../outside.md" }),
        ("read_memory", new() { ["filePath"] = "a/./b/../../NOTES.md" }),
        ("read_memory", new() { ["filePath"] = "memory" }),
        ("read_memory", new() { ["filePath"] = "missing.md" }),
        ("read_memory", new() { ["filePath"] = "sub/.." }),
        ("edit_memory", new() { ["filePath"] = "nope/x.md", ["oldText"] = "x", ["newText"] = "y" }),
        ("edit_memory", new() { ["filePath"] = "NOTES.md/x.md", ["oldText"] = "x", ["newText"] = "y" }),
        ("edit_memory", new() { ["filePath"] = "sub/..", ["oldText"] = "x", ["newText"] = "y" }),
        ("write_memory", new() { ["filePath"] = "sub/..", ["content"] = "x" }),
        ("delete_memory", new() { ["filePath"] = "sub/.." }),
        (
            "apply_patch_memory",
            new()
            {
                ["input"] =
                    "*** Begin Patch\n*** Add File: p.md\n+hello\n*** Update File: NOTES.md\n@@\n-one\n+uno\n*** Delete File: sub/deep/a.md\n*** End Patch",
            }
        ),
        ("read_memory", new() { ["filePath"] = "NOTES.md" }),
        ("read_memory", new() { ["filePath"] = "sub/deep" }),
        (
            "apply_patch_memory",
            new()
            {
                ["input"] =
                    "*** Begin Patch\n*** Delete File: p.md\n*** Add File: sub/b.md\n+again\n*** Delete File: none.md\n*** End Patch",
            }
        ),
        ("apply_patch_memory", new() { ["input"] = "*** Begin Patch\n*** Add File: /abs.md\n+x\n*** End Patch" }),
        ("read_memory", new() { ["filePath"] = "MEMORY.md", ["agentName"] = "other" }),
        ("write_memory", new() { ["filePath"] = "added.md", ["content"] = "x", ["agentName"] = "other" }),
        ("delete_memory", new() { ["filePath"] = "added.md", ["agentName"] = "other" }),
        ("read_memory", new() { ["filePath"] = "MEMORY.md", ["agentName"] = "ghost" }),
        ("read_memory", new() { ["filePath"] = "MEMORY.md", ["agentName"] = " other" }),
    ];

    private static async Task<string[]> RunMemoryScriptAsync(StoreFixture fixture)
    {
        await fixture.Manager.CreateAgentAsync("other", createMainSession: false, initialMemory: "OTHER\n");
        var seen = new List<string>();
        foreach (var (tool, args) in MemoryScript)
            seen.Add(
                tool
                    + " "
                    + args.ToJsonString()
                    + "\n"
                    + Seen(await fixture.Call(tool, (JsonObject)args.DeepClone()), fixture.Manager)
            );
        return seen.ToArray();
    }

    [Fact]
    public async Task Memory_tools_return_over_the_store_what_they_return_over_folders()
    {
        await using var folders = await StoreFixture.Create(store: false);
        await using var store = await StoreFixture.Create(store: true);
        Assert.Null(folders.Manager.AgentStore);
        Assert.NotNull(store.Manager.AgentStore);
        var expected = await RunMemoryScriptAsync(folders);
        var actual = await RunMemoryScriptAsync(store);
        for (var index = 0; index < expected.Length; index++)
            Assert.Equal(expected[index], actual[index]);
        // The writes are the store's: nothing appeared in an Agent folder.
        Assert.Equal("uno\nthree\n", await store.Store.ReadTextAsync("main", "memory/NOTES.md", None));
        Assert.Equal("OTHER\n", await store.Store.ReadTextAsync("other", "memory/MEMORY.md", None));
        Assert.False(Directory.Exists(Path.Combine(store.Inner.Work, "agents")));
        Assert.False(Directory.Exists(Path.Combine(store.Inner.Work, "other")));
    }

    [Fact]
    public async Task Conditions_folders_lack_use_the_store_texts()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        Assert.Equal(
            "Invalid path 'memory/e\u0301.md': it isn't in Unicode NFC form.",
            (await fixture.Call("write_memory", new() { ["filePath"] = "e\u0301.md", ["content"] = "x" })).FailureMessage()
        );
        var first = await fixture.Store.ReadAsync("main", "memory/MEMORY.md", None);
        await fixture.Store.WriteAsync("main", "memory/MEMORY.md", "two"u8.ToArray(), null, None);
        var conflict = await Assert.ThrowsAsync<AgentFileConflictException>(() =>
            fixture.Store.WriteAsync("main", "memory/MEMORY.md", "three"u8.ToArray(), first.Generation, None)
        );
        Assert.Equal("memory/MEMORY.md changed since it was read. Read it again, then retry.", conflict.Message);
    }

    // Writes an Agent file (agent null: the installation's prompt files) where the fixture
    // keeps Agent files.
    private static async Task WriteAgentFileAsync(StoreFixture fixture, string? agent, string path, string text)
    {
        if (fixture.Manager.AgentStore is { } store)
        {
            await store.WriteAsync(agent, path, System.Text.Encoding.UTF8.GetBytes(text), null, None);
            return;
        }
        var root = agent is null
            ? Path.Combine(fixture.Inner.Work, "agents")
            : fixture.Manager.AgentDirectory(agent);
        var full = Path.Combine(root, path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        await File.WriteAllTextAsync(full, text);
    }

    private static async Task<string> PromptAsync(StoreFixture fixture)
    {
        await fixture.Manager.CreateAgentAsync("helper", createMainSession: false, initialMemory: "HELPER MEMORY\n");
        await fixture.Manager.CreateAgentAsync(
            "child",
            createMainSession: false,
            initialMemory: "CHILD MEMORY\n",
            inherit: "helper",
            initialSoul: "CHILD SOUL\n"
        );
        await WriteAgentFileAsync(fixture, null, FrameworkPrompt.LocalFileName, "LOCAL ADDITION\n");
        await WriteAgentFileAsync(fixture, "child", "memory/USER.md", "USER NOTES\n");
        await WriteAgentFileAsync(fixture, "child", "memory/archive/old.md", "NOT INJECTED\n");
        await WriteAgentFileAsync(fixture, "helper", "memory/A.md", "HELPER A\n");
        await WriteAgentFileAsync(
            fixture,
            "child",
            "skills/child-demo/SKILL.md",
            "---\ndescription: Child skill.\nrun:\n  entry: run.py\n  effect: Returns one.\n---\nBody\n"
        );
        await WriteAgentFileAsync(fixture, "child", "skills/child-demo/run.py", "return 1\n");
        await WriteAgentFileAsync(fixture, "helper", "skills/helper-demo/SKILL.md", "Helper skill body paragraph.\n");
        var owner = await fixture.Manager.CreateNamedAsync("child", "prompt", null, null);
        await fixture.Manager.RefreshSnapshotAsync(owner);
        await fixture.Manager.RefreshSnapshotAsync(fixture.Inner.Owner);
        return SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"])!
            + "\n=====\n"
            + SessionWait.Text(fixture.Inner.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]);
    }

    [Fact]
    public async Task The_composed_prompt_over_the_store_is_byte_identical_to_the_folder_prompt()
    {
        await using var folders = await StoreFixture.Create(store: false);
        await using var store = await StoreFixture.Create(store: true);
        var expected = await PromptAsync(folders);
        var actual = await PromptAsync(store);
        Assert.Contains("LOCAL ADDITION", expected);
        Assert.Contains("CHILD SOUL", expected);
        Assert.Contains("HELPER A", expected);
        Assert.Contains("USER NOTES", expected);
        Assert.Contains("child-demo", expected);
        Assert.Contains("helper-demo", expected);
        Assert.DoesNotContain("NOT INJECTED", expected);
        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task The_Agent_lifecycle_creates_copies_and_removes_store_Agents()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        var store = fixture.Store;
        Assert.True(store.AgentExists("main"));
        Assert.NotEmpty(store.List("main", "memory"));
        await fixture.Call("write_memory", new() { ["filePath"] = "deep/NOTE.md", ["content"] = "copied" });

        await fixture.Manager.CreateAgentAsync("fresh", createMainSession: false, initialMemory: "M", initialSoul: "S");
        Assert.Equal(
            ["memory/MEMORY.md", "memory/SOUL.md"],
            store.Tree("fresh", "").Select(entry => entry.Path)
        );
        Assert.Contains("fresh", fixture.Manager.Agents());

        await fixture.Manager.CreateAgentAsync(
            "copy",
            createMainSession: false,
            inheritMemory: true,
            sourceSession: fixture.Inner.Owner
        );
        Assert.Equal("copied", await store.ReadTextAsync("copy", "memory/deep/NOTE.md", None));
        Assert.Equal(
            store.Tree("main", "memory").Select(entry => entry.Path),
            store.Tree("copy", "memory").Select(entry => entry.Path)
        );

        await fixture.Manager.DeleteAgentAsync("copy");
        Assert.False(store.AgentExists("copy"));
        Assert.Empty(store.Tree("copy", ""));
        Assert.DoesNotContain("copy", fixture.Manager.Agents());
        // A deleted Agent's name is free again, in the store as in the catalog.
        await fixture.Manager.CreateAgentAsync("copy", createMainSession: false);
        Assert.True(store.AgentExists("copy"));
        Assert.False(Directory.Exists(Path.Combine(fixture.Inner.Work, "agents")));
    }

    [Fact]
    public async Task A_move_into_a_new_Agent_creates_it_in_the_store_and_removes_its_proof()
    {
        await using var fixture = await StoreFixture.Create(store: true);
        var owner = await fixture.Manager.CreateNamedAsync("main", "mover", null, null);
        var moved = await fixture.Call(
            "move_session",
            new()
            {
                ["sessionId"] = owner.Id,
                ["newAgentName"] = "moved",
                ["createAgent"] = true,
                ["createAgentInheritMemory"] = true,
            }
        );
        Assert.Null(moved.FailureMessage());
        Assert.True(fixture.Store.AgentExists("moved"));
        Assert.Null(fixture.Store.Stat("moved", AgentCatalog.IdentityProofFileName));
        Assert.Equal(
            fixture.Store.Tree("main", "memory").Select(entry => entry.Path),
            fixture.Store.Tree("moved", "memory").Select(entry => entry.Path)
        );
    }

    private static readonly (string Tool, JsonObject Args)[] SkillScript =
    [
        ("skill", new() { ["action"] = "list" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "child-demo" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "child-demo", ["path"] = "run.py" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "child-demo", ["path"] = "docs/" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "child-demo", ["path"] = "../x" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "child-demo", ["path"] = "node_modules/m.js" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "helper-demo" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "nested/inner" }),
        ("skill", new() { ["action"] = "load", ["skillName"] = "missing" }),
        ("run_skill", new() { ["skillName"] = "child-demo" }),
        ("run_skill", new() { ["skillName"] = "child-demo", ["script"] = "docs/other.py" }),
        ("run_skill", new() { ["skillName"] = "helper-demo" }),
    ];

    [Fact]
    public async Task Skills_load_and_run_from_the_store_as_from_folders()
    {
        async Task<string[]> RunAsync(StoreFixture fixture)
        {
            await PromptAsync(fixture);
            await WriteAgentFileAsync(fixture, "child", "skills/child-demo/docs/guide.md", "Guide\n");
            await WriteAgentFileAsync(fixture, "child", "skills/child-demo/docs/other.py", "return 'other'\n");
            await WriteAgentFileAsync(fixture, "child", "skills/child-demo/node_modules/m.js", "skipped\n");
            await WriteAgentFileAsync(fixture, "child", "skills/nested/inner/SKILL.md", "Inner skill.\n");
            var owner = await fixture.Manager.RequiredAsync("child/prompt");
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            var tools = fixture.Inner.Executor(owner);
            var seen = new List<string>();
            foreach (var (tool, args) in SkillScript)
            {
                var text = Seen(await fixture.Call(tool, (JsonObject)args.DeepClone(), tools), fixture.Manager);
                seen.Add(tool + " " + args.ToJsonString() + "\n" + Regex.Replace(text, "\"runId\":\"[^\"]+\"", "<run>"));
            }
            return seen.ToArray();
        }
        await using var folders = await StoreFixture.Create(store: false);
        await using var store = await StoreFixture.Create(store: true);
        var expected = await RunAsync(folders);
        var actual = await RunAsync(store);
        Assert.Contains("Child skill.", expected[0]);
        Assert.Contains("return 1", expected[2]);
        for (var index = 0; index < expected.Length; index++)
            Assert.Equal(expected[index], actual[index]);
    }

    // Rules the generated isolation layer and the restricted-worker templates rely on: memory
    // tools allowed inside the Agent's own memory directory, everything else denied; and the
    // operation-rule form of the same confinement.
    private static readonly string[] ConfinementRules =
    [
        """[{"id":"own","match":{"tool":{"source":"builtin","name":["read_memory","write_memory","edit_memory","delete_memory","apply_patch_memory"]},"path":{"allWithin":"${agent.memoryDir}"}},"action":"allow"},{"id":"rest","action":"deny"}]""",
        """[{"id":"outside","match":{"tool":{"source":"builtin"},"path":{"anyNotWithin":"${agent.memoryDir}/notes"}},"action":"deny"}]""",
        """[{"id":"outside","match":{"tool":{"source":"builtin"},"path":{"anyNotWithin":"${agent.memoryDir}/./x/../notes//"}},"action":"deny"}]""",
        """[{"id":"within","op":"env.write","path":{"notWithin":"${agent.dir}//memory/./notes"},"action":"deny"}]""",
        """[{"id":"writes","op":"env.write","path":{"within":"${agent.memoryDir}"},"action":"allow"},{"id":"reads","op":"env.read","path":{"within":"${agent.dir}"},"action":"allow"},{"id":"rest","action":"deny"}]""",
        """[{"id":"elsewhere","op":"env.read","path":{"within":"/elsewhere"},"action":"deny"},{"id":"any-node","op":"env.write","node":{"provider":"authenticated-remote"},"action":"deny"}]""",
    ];

    private static readonly (string Tool, JsonObject Args)[] ConfinedScript =
    [
        ("read_memory", new() { ["filePath"] = "MEMORY.md" }),
        ("write_memory", new() { ["filePath"] = "notes/a.md", ["content"] = "a" }),
        ("write_memory", new() { ["filePath"] = "b.md", ["content"] = "b" }),
        ("read_memory", new() { ["filePath"] = "notes/a.md" }),
        ("read_memory", new() { ["filePath"] = "MEMORY.md", ["agentName"] = "main" }),
        ("write_memory", new() { ["filePath"] = "x.md", ["content"] = "x", ["agentName"] = "main" }),
        ("apply_patch_memory", new() { ["input"] = "*** Begin Patch\n*** Add File: notes/c.md\n+c\n*** End Patch" }),
    ];

    private readonly List<string> Denials = [];

    [Fact]
    public async Task Path_rules_decide_store_paths_as_they_decide_folder_paths()
    {
        async Task<string[]> RunAsync(StoreFixture fixture)
        {
            var seen = new List<string>();
            for (var index = 0; index < ConfinementRules.Length; index++)
            {
                var agent = "boxed" + index;
                await fixture.Manager.CreateAgentAsync(
                    agent,
                    createMainSession: false,
                    initialMemory: "BOXED\n",
                    rules: JsonNode.Parse(ConfinementRules[index])!.AsArray()
                );
                var owner = await fixture.Manager.CreateNamedAsync(agent, "s", null, null);
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
                var tools = fixture.Inner.Executor(owner);
                foreach (var (tool, args) in ConfinedScript)
                {
                    // A denial names the operation's facts, which are store paths here and
                    // physical paths there; the decision and every other result must agree.
                    var result = await fixture.Call(tool, (JsonObject)args.DeepClone(), tools);
                    var denied = result.FailureMessage() is { } failure && failure.Contains("denied", StringComparison.OrdinalIgnoreCase);
                    if (denied && fixture.Manager.AgentStore is not null)
                        Denials.Add(result.FailureMessage()!);
                    seen.Add(
                        agent + " " + tool + " " + args.ToJsonString() + "\n"
                            + (denied ? "DENIED" : Seen(result, fixture.Manager))
                    );
                }
            }
            return seen.ToArray();
        }
        await using var folders = await StoreFixture.Create(store: false);
        await using var store = await StoreFixture.Create(store: true);
        var expected = await RunAsync(folders);
        var actual = await RunAsync(store);
        // Own memory is allowed and another Agent's denied under the confinement rules.
        Assert.DoesNotContain("DENIED", actual[0]);
        Assert.EndsWith("DENIED", actual[4]);
        Assert.EndsWith("DENIED", actual[5]);
        Assert.Contains(Denials, denial => denial.Contains("(node `@agent`, path `main/memory/MEMORY.md`)", StringComparison.Ordinal));
        for (var index = 0; index < expected.Length; index++)
            Assert.Equal(expected[index], actual[index]);
    }
}
