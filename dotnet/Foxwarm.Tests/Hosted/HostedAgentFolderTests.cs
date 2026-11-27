using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The Agent folder without master: `$fw_agentdir` paths of a Session without a Node and the
/// `node:@agent` file tools reach the Agent's files in the store, with the results the same
/// calls have on master over a folder.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class HostedAgentFolderTests(ITestOutputHelper output)
{
    internal static JsonObject Values(JsonObject args) => new() { ["a"] = args };

    // Calls by a Session without a Node (hosted) or on master (file mode).
    private static readonly (string Name, JsonObject Args)[] Script =
    [
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["content"] = "one\n" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["content"] = "one\n", ["createDirs"] = true }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/a.md/x", ["content"] = "x" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs/a.md" }),
        ("edit", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["oldText"] = "one", ["newText"] = "two" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["content"] = "again" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["content"] = "three\n", ["overwrite"] = true }),
        ("read", new() { ["filePath"] = "$fw_agentdir/missing.md" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs/a.md/below" }),
        (
            "edit",
            new()
            {
                ["apply_patch"] =
                    "*** Begin Patch\n*** Add File: $fw_agentdir/docs/b.md\n+bee\n*** Update File: $fw_agentdir/docs/a.md\n@@\n-three\n+four\n*** End Patch",
            }
        ),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs/b.md" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs/a.md", ["startLine"] = 1, ["endLine"] = 1 }),
        // A write to an existing directory, a name starting with `$`, and a patch that deletes
        // a directory.
        ("write", new() { ["filePath"] = "$fw_agentdir/docs", ["content"] = "d" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs", ["content"] = "d", ["overwrite"] = true }),
        ("write", new() { ["filePath"] = "$fw_agentdir/$x.md", ["content"] = "dollar\n" }),
        ("edit", new() { ["filePath"] = "$fw_agentdir/$x.md", ["oldText"] = "dollar", ["newText"] = "cash" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/$x.md" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/empty/x", ["content"] = "x", ["createDirs"] = true }),
        ("edit", new() { ["apply_patch"] = "*** Begin Patch\n*** Delete File: $fw_agentdir/empty/x\n*** End Patch" }),
        ("edit", new() { ["apply_patch"] = "*** Begin Patch\n*** Delete File: $fw_agentdir/empty\n*** End Patch" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/empty" }),
        (
            "ctl",
            new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "docs/b.md" }) }
        ),
        (
            "ctl",
            new()
            {
                ["command"] = "tool call node:@agent/write --args @a",
                ["values"] = Values(new() { ["filePath"] = "$fw_agentdir/notes/c.md", ["content"] = "sea", ["createDirs"] = true }),
            }
        ),
        (
            "ctl",
            new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "notes/./c.md" }) }
        ),
        (
            "ctl",
            new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "/etc/hostname" }) }
        ),
        (
            "ctl",
            new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "notes/../../x" }) }
        ),
        (
            "ctl",
            new() { ["command"] = "tool call node:@agent/exec --args @a", ["values"] = Values(new() { ["command"] = "true" }) }
        ),
        // Configuration candidates in the Agent folder.
        ("write", new() { ["filePath"] = "$fw_agentdir/rules.yaml", ["content"] = "version: 1\ndefaultAction: allow\nrules:\n  - id: no-list\n    tool: {source: builtin, name: list_agents}\n    action: deny\n" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/bad.yaml", ["content"] = "version: 7\n" }),
        ("explain_tool_authorization", new() { ["policyFilePath"] = "$fw_agentdir/bad.yaml", ["probes"] = Probe() }),
        ("explain_tool_authorization", new() { ["policyFilePath"] = "$fw_agentdir/missing.yaml", ["probes"] = Probe() }),
        ("explain_tool_authorization", new() { ["policyFilePath"] = "$fw_agentdir/docs", ["probes"] = Probe() }),
        ("set_config", new() { ["target"] = "tool-rules", ["filePath"] = "$fw_agentdir/bad.yaml" }),
        ("set_config", new() { ["target"] = "tool-rules", ["filePath"] = "$fw_agentdir/missing.yaml" }),
        // A valid candidate, explained and then installed.
        ("explain_tool_authorization", new() { ["policyFilePath"] = "$fw_agentdir/rules.yaml", ["probes"] = Probe() }),
        ("set_config", new() { ["target"] = "tool-rules", ["filePath"] = "$fw_agentdir/rules.yaml" }),
        ("explain_tool_authorization", new() { ["probes"] = Probe() }),
    ];

    // The same available call in both modes, denied by the candidate.
    private static JsonArray Probe() =>
        new(new JsonObject { ["sessionId"] = "profile", ["toolId"] = "builtin:list_agents", ["args"] = new JsonObject() });

    // The policy each call of the script is explained under before it runs: allow, ask and deny
    // by Node and by path.
    private const string ProbePolicy = """
        version: 1
        defaultAction: allow
        rules:
          - id: ask-b
            tool: {source: node, name: [read, write, edit]}
            path: {allWithin: "${agent.dir}/docs/b.md"}
            action: ask
          - id: deny-notes
            tool: {source: node}
            path: {allWithin: "${agent.dir}/notes"}
            action: deny
          - id: ask-master-edit
            tool: {source: node, name: edit}
            node: {exact: master}
            action: ask
        """;

    // What policy decides for a call: the decision, each layer's decision and rule, and the
    // resolved resources, with folder paths in one spelling for both modes.
    internal static string Semantics(JsonObject result, SessionManager manager)
    {
        if (result.FailureMessage() is { } failure)
            return "ERROR " + Seen(result, manager);
        var text = SessionWait.Text(result["output"]);
        var explained = text is null ? result : JsonNode.Parse(text)!.AsObject();
        var probe = explained["probes"]![0]!.AsObject();
        if (probe["error"] is { } error)
            return "PROBE ERROR " + Normalize(error.ToJsonString(), manager);
        var decided = probe["active"] ?? probe["candidate"]!;
        var parts = new List<string> { "decision " + decided["decision"] };
        foreach (var layer in decided["layers"]!.AsArray())
            parts.Add($"{layer!["layer"]} {layer["decision"]} {layer["rule"]?["id"] ?? "default"}");
        foreach (var path in decided["facts"]?["paths"]?.AsArray() ?? [])
            parts.Add("path " + Resource(SessionWait.Text(path!["node"]), SessionWait.Text(path["resolved"]), manager));
        foreach (var operation in probe["operations"]?.AsArray() ?? [])
            parts.Add(
                $"op {operation!["op"]} "
                    + Resource(SessionWait.Text(operation["resources"]?["node"]), SessionWait.Text(operation["resources"]?["path"]), manager)
            );
        return string.Join("; ", parts);
    }

    private static string Resource(string? node, string? path, SessionManager manager)
    {
        if (node == "@agent" && path is not null)
            return "folder:" + (path == "main" ? "" : path["main/".Length..]);
        if (manager.AgentStore is null && node == "master" && path is not null)
        {
            var root = Foxwarm.Tools.AuthorizationPaths.CanonicalPotential(manager.AgentDirectory("main"));
            if (path == root || path.StartsWith(root + "/", StringComparison.Ordinal))
                return "folder:" + path[root.Length..].TrimStart('/');
        }
        return node + ":" + path;
    }

    private static string Normalize(string text, SessionManager manager) =>
        manager.AgentStore is null ? text.Replace(manager.AgentDirectory("main"), "$fw_agentdir", StringComparison.Ordinal) : text;

    // The explanation of one call of the script under the probe policy.
    private static JsonObject ExplainCall(string name, JsonObject args)
    {
        var probe = new JsonObject { ["sessionId"] = "profile" };
        if (name == "ctl")
        {
            probe["command"] = args["command"]!.DeepClone();
            probe["values"] = args["values"]?.DeepClone();
        }
        else if (name is "read" or "write" or "edit")
        {
            probe["source"] = "node";
            probe["name"] = name;
            probe["args"] = args.DeepClone();
        }
        else
        {
            probe["toolId"] = "builtin:" + name;
            probe["args"] = args.DeepClone();
        }
        return new JsonObject { ["policyFilePath"] = "$fw_agentdir/.probe/rules.yaml", ["probes"] = new JsonArray(probe) };
    }

    internal static string Seen(JsonObject result, SessionManager manager)
    {
        var text = result.FailureMessage() is { } failure
            ? "ERROR " + failure
            : SessionWait.Text(result["output"]) ?? result.ToJsonString();
        if (manager.AgentStore is null)
            text = text.Replace(manager.AgentDirectory("main"), "$fw_agentdir", StringComparison.Ordinal);
        text = System.Text.RegularExpressions.Regex.Replace(text, "write_[0-9a-f]{12}", "write_<ref>");
        return System.Text.RegularExpressions.Regex.Replace(text, @"\d{4}-\d\d-\d\d[ T][0-9:.]+Z?", "<time>");
    }

    // Each call's explanation under the probe policy, then the call itself.
    private async Task<(string[] Seen, string[] Decided)> RunAsync(HostedCapabilityProfileTests.Fixture fixture)
    {
        Assert.Null(
            (await fixture.Call("write", new() { ["filePath"] = "$fw_agentdir/.probe/rules.yaml", ["content"] = ProbePolicy, ["createDirs"] = true })).FailureMessage()
        );
        var seen = new List<string>();
        var decided = new List<string>();
        foreach (var (name, args) in Script)
        {
            var semantics = Semantics(await fixture.Call("explain_tool_authorization", ExplainCall(name, args)), fixture.Manager);
            var text = Seen(await fixture.Call(name, (JsonObject)args.DeepClone()), fixture.Manager);
            output.WriteLine($"{name} {args.ToJsonString()}\n  {semantics}\n  {text}");
            seen.Add(text);
            decided.Add(semantics);
        }
        return (seen.ToArray(), decided.ToArray());
    }

    [Fact]
    public async Task Agent_folder_calls_without_master_return_what_they_return_on_master()
    {
        await using var file = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        var expected = await RunAsync(file);
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var actual = await RunAsync(store.Inner);
        for (var index = 0; index < Script.Length; index++)
        {
            Assert.True(expected.Decided[index] == actual.Decided[index], $"policy {index}: {Script[index].Name}\nfile:  {expected.Decided[index]}\nstore: {actual.Decided[index]}");
            Assert.True(expected.Seen[index] == actual.Seen[index], $"call {index}: {Script[index].Name}\nfile:  {expected.Seen[index]}\nstore: {actual.Seen[index]}");
        }
        Assert.Equal("four\n", await store.Store.ReadTextAsync("main", "docs/a.md", default));
        Assert.Equal("cash\n", await store.Store.ReadTextAsync("main", "$x.md", default));
        Assert.True(store.Store.Stat("main", "empty")!.IsDirectory);
        // The probe policy decided the script with each kind of decision.
        Assert.Contains(actual.Decided, item => item.StartsWith("decision ask; global ask ask-b", StringComparison.Ordinal));
        Assert.Contains(actual.Decided, item => item.StartsWith("decision deny; global deny deny-notes", StringComparison.Ordinal));
        Assert.Contains(actual.Decided, item => item.StartsWith("decision allow;", StringComparison.Ordinal));
        // The installed candidate is the active policy.
        Assert.Contains("no-list", actual.Seen[^1]);
    }

    private static string Template(string name) =>
        File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "skills", "agent-management", "references", "memory-templates", name + ".rules.json")
        );

    // Layers whose master selectors also decide `@agent` where there is no master.
    private static readonly (string Name, string Rules)[] AliasLayers =
    [
        ("worker", Template("restricted-worker")),
        ("assistant", Template("channel-assistant")),
        (
            "isolated",
            """[{"id":"master-files","match":{"tool":{"source":"node","name":["read","write","edit"]},"targetNode":"master","path":{"allWithin":"${agent.dir}"}},"action":"allow"},{"id":"copy","match":{"tool":{"source":"builtin","name":"copy_between_nodes"},"args":{"sourceNode":"master","targetNode":"master"},"path":{"arg":["sourcePath","targetPath"],"allWithin":"${agent.dir}"}},"action":"allow"},{"id":"rest","action":"deny"}]"""
        ),
        ("nomaster", """[{"id":"no-master","node":{"exact":"master"},"action":"deny"}]"""),
        ("opnomaster", """[{"id":"no-master-writes","op":"env.write","node":{"exact":"master"},"action":"deny"}]"""),
    ];

    private static readonly (string Name, JsonObject Args)[] AliasScript =
    [
        ("copy_between_nodes", new() { ["sourceNode"] = "@agent", ["sourcePath"] = "docs/a.md", ["targetNode"] = "@agent", ["targetPath"] = "docs/b.md" }),
        ("ctl", new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = ".temp/channel-files/in.txt" }) }),
        ("ctl", new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "docs/a.md" }) }),
        ("read", new() { ["filePath"] = "$fw_agentdir/.temp/channel-files/in.txt" }),
        ("read", new() { ["filePath"] = "$fw_agentdir/docs/a.md" }),
        ("write", new() { ["filePath"] = "$fw_agentdir/docs/c.md", ["content"] = "c" }),
    ];

    internal static async Task SeedAsync(HostedCapabilityProfileTests.Fixture fixture, string agent)
    {
        if (fixture.Manager.AgentStore is { } store)
        {
            await store.WriteAsync(agent, "docs/a.md", "a\n"u8.ToArray(), null, default);
            await store.WriteAsync(agent, ".temp/channel-files/in.txt", "in\n"u8.ToArray(), null, default);
            return;
        }
        var root = fixture.Manager.AgentDirectory(agent);
        Directory.CreateDirectory(Path.Combine(root, "docs"));
        Directory.CreateDirectory(Path.Combine(root, ".temp", "channel-files"));
        await File.WriteAllTextAsync(Path.Combine(root, "docs", "a.md"), "a\n");
        await File.WriteAllTextAsync(Path.Combine(root, ".temp", "channel-files", "in.txt"), "in\n");
    }

    internal static string Decision(JsonObject result, SessionManager manager) =>
        result.FailureCode() == "tool_authorization_denied"
            ? "DENIED " + System.Text.RegularExpressions.Regex.Match(result.FailureMessage() ?? "", "Rule `([a-z-]+)`").Groups[1].Value
            : result.FailureMessage() is { } failure ? "ERROR " + Seen(result, manager) : "OK";

    private async Task<Dictionary<string, string>> AliasRunAsync(HostedCapabilityProfileTests.Fixture fixture, IEnumerable<(string Name, string Rules)> layers)
    {
        var seen = new Dictionary<string, string>();
        foreach (var (name, rules) in layers)
        {
            await fixture.Manager.CreateAgentAsync(name, createMainSession: false, rules: JsonNode.Parse(rules)!.AsArray());
            await SeedAsync(fixture, name);
            var owner = await fixture.Manager.CreateNamedAsync(name, "s", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            var tools = fixture.Executor(owner);
            for (var index = 0; index < AliasScript.Length; index++)
            {
                var (tool, args) = AliasScript[index];
                var result = await fixture.Call(tool, (JsonObject)args.DeepClone(), tools);
                var last = result.FailureMessage();
                var decision = Decision(result, fixture.Manager);
                output.WriteLine($"{name} {index} {tool} {args.ToJsonString()}\n  {decision}\n  {last}");
                seen[name + " " + index] = decision;
            }
        }
        return seen;
    }

    [Fact]
    public async Task Master_selectors_decide_the_Agent_folder_as_they_decide_master()
    {
        await using var folders = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var expected = await AliasRunAsync(folders, AliasLayers);
        var actual = await AliasRunAsync(store.Inner, AliasLayers);
        Assert.Equal(expected, actual);
        // The templates' intent: a worker's copy is denied; an assistant reads received files
        // and nothing else of its folder; an isolated Agent copies within its own folder.
        Assert.StartsWith("DENIED", actual["worker 0"]);
        Assert.Equal("OK", actual["assistant 1"]);
        Assert.Equal("OK", actual["assistant 3"]);
        Assert.Equal("DENIED no-master", actual["assistant 2"]);
        Assert.Equal("DENIED no-master", actual["assistant 4"]);
        Assert.Equal("OK", actual["isolated 0"]);
        Assert.Equal("OK", actual["isolated 5"]);
        Assert.Equal("DENIED no-master", actual["nomaster 2"]);
        Assert.Equal("OK", actual["opnomaster 4"]);
        Assert.Equal("DENIED no-master-writes", actual["opnomaster 5"]);
    }

    [Fact]
    public async Task An_Agent_folder_selector_selects_only_the_endpoint_and_never_changes_a_file_mode_decision()
    {
        var layers = new[] { ("endpoint", """[{"id":"agent-only","node":{"exact":"@agent"},"action":"deny"}]""") };
        await using var folders = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var onMaster = await AliasRunAsync(folders, layers);
        var withoutMaster = await AliasRunAsync(store.Inner, layers);
        // On master every call is master's, which an `@agent` selector doesn't name.
        Assert.All(onMaster.Values, decision => Assert.DoesNotContain("DENIED", decision));
        Assert.All(withoutMaster.Values, decision => Assert.Equal("DENIED agent-only", decision));
    }

    [Fact]
    public async Task An_isolated_copy_reaches_no_other_Agent()
    {
        var layers = new[] { AliasLayers[2] };
        await using var folders = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        await folders.Manager.CreateAgentAsync("isolated", createMainSession: false, rules: JsonNode.Parse(layers[0].Rules)!.AsArray());
        await SeedAsync(folders, "isolated");
        var owner = await folders.Manager.CreateNamedAsync("isolated", "s", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var other = Path.Combine(folders.Manager.AgentDirectory("main"), "x.md");
        var denied = await folders.Call(
            "copy_between_nodes",
            new() { ["sourceNode"] = "@agent", ["sourcePath"] = "docs/a.md", ["targetNode"] = "master", ["targetPath"] = other },
            folders.Executor(owner)
        );
        Assert.Equal("DENIED rest", Decision(denied, folders.Manager));
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        await store.Manager.CreateAgentAsync("isolated", createMainSession: false, rules: JsonNode.Parse(layers[0].Rules)!.AsArray());
        await SeedAsync(store.Inner, "isolated");
        var hostedOwner = await store.Manager.CreateNamedAsync("isolated", "s", null, null);
        hostedOwner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var outside = await store.Call(
            "copy_between_nodes",
            new() { ["sourceNode"] = "@agent", ["sourcePath"] = "docs/a.md", ["targetNode"] = "@agent", ["targetPath"] = "../main/x.md" },
            store.Inner.Executor(hostedOwner)
        );
        Assert.Equal("`@agent` reaches only this Agent's own folder: ../main/x.md.", outside.FailureMessage());
        Assert.Null(store.Store.Stat("main", "x.md"));
    }

    [Fact]
    public async Task Clearing_the_Node_selection_leaves_master_or_no_Node()
    {
        await using var folders = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        var cleared = await folders.Call("ctl", new() { ["command"] = "node select --none" });
        Assert.Null(cleared.FailureMessage());
        Assert.Contains("\"nodeId\":\"master\"", cleared.ToJsonString().Replace("\\\"", "\""));
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var none = await store.Call("node", new() { ["action"] = "select", ["none"] = true });
        Assert.Null(none.FailureMessage());
        output.WriteLine(none.ToJsonString());
        Assert.Contains("\"nodeId\":null", none.ToJsonString().Replace("\\\"", "\""));
        var both = await store.Call("node", new() { ["action"] = "select", ["none"] = true, ["nodeId"] = "x" });
        Assert.Equal("select takes either nodeId or none, not both.", both.FailureMessage());
        // Afterwards `$fw_agentdir` paths are the Agent folder's, and `$fw_tmp` isn't available.
        Assert.Null((await store.Call("write", new() { ["filePath"] = "$fw_agentdir/n.md", ["content"] = "n" })).FailureMessage());
        Assert.Equal(
            "`$fw_tmp` isn't available here; use a path under `$fw_agentdir/`.",
            (await store.Call("ctl", new() { ["command"] = "tool call node:@agent/read --args @a", ["values"] = Values(new() { ["filePath"] = "$fw_tmp/x" }) })).FailureMessage()
        );
    }

    [Fact]
    public async Task An_explanation_names_the_endpoint_and_a_match_through_the_master_alias()
    {
        async Task<string> ExplainAsync(HostedCapabilityProfileTests.Fixture fixture)
        {
            // Narrow enough to leave the explanation's own policy read alone.
            var rules = """[{"id":"no-master","tool":{"source":"node","name":"read"},"node":{"exact":"master"},"path":{"allWithin":"${agent.dir}/docs"},"action":"deny"}]""";
            await fixture.Manager.CreateAgentAsync("nomaster", createMainSession: false, rules: JsonNode.Parse(rules)!.AsArray());
            var owner = await fixture.Manager.CreateNamedAsync("nomaster", "s", null, null);
            owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            var probe = new JsonObject { ["sessionId"] = owner.Id, ["toolId"] = "node:@agent/read", ["args"] = new JsonObject { ["filePath"] = "docs/a.md" } };
            var result = await fixture.Call("explain_tool_authorization", new() { ["probes"] = new JsonArray(probe) }, fixture.Executor(owner));
            Assert.Null(result.FailureMessage());
            var text = SessionWait.Text(result["output"]) ?? result.ToJsonString();
            output.WriteLine(text);
            return text;
        }
        await using var folders = await HostedCapabilityProfileTests.Fixture.Create(RuntimeCapabilities.File);
        var onMaster = await ExplainAsync(folders);
        Assert.Contains("no-master", onMaster);
        Assert.DoesNotContain("masterAlias", onMaster);
        await using var store = await HostedAgentStoreTests.StoreFixture.Create(store: true);
        var withoutMaster = await ExplainAsync(store.Inner);
        Assert.Contains("no-master", withoutMaster);
        Assert.Contains("\"masterAlias\":true", withoutMaster.Replace(" ", "").Replace("\n", ""));
        Assert.Contains("@agent", withoutMaster);
    }
}
