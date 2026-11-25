using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// Skill access for restricted Agents: the catalog and `skill list` follow the `skill` and
// `run_skill` rules. Copy is checked as data, never as wording.
public sealed partial class SkillAccessTests
{
    private const string Runnable = "run:\n  entry: scripts/run.py\n  effect: Returns one.\n";

    private static JsonArray RestrictedWorkerRules() =>
        JsonNode
            .Parse(
                File.ReadAllText(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "skills",
                        "agent-management",
                        "references",
                        "memory-templates",
                        "restricted-worker.rules.json"
                    )
                )
            )!
            .AsArray();

    private static JsonArray Rules(string json) => JsonNode.Parse(json)!.AsArray();

    private sealed class Host : IAsyncDisposable
    {
        internal readonly TempDirectory Skills = new();
        internal ScriptFixture F = null!;

        internal static async Task<Host> Create()
        {
            var host = new Host();
            host.F = await ScriptFixture.Create(host.Skills.Path);
            return host;
        }

        internal string Write(string name, string frontmatter = Runnable, string? entry = "scripts/run.py") =>
            RunnableSkillTests.WriteSkill(Skills.Path, name, frontmatter, entry);

        internal string PolicyPath => Path.Combine(F.Data, "state", "tool-authorization.yaml");

        internal async Task Policy(string yaml)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(PolicyPath)!);
            await File.WriteAllTextAsync(PolicyPath, yaml);
            F.Manager.Authorization.Invalidate();
        }

        // A Session of a new Agent with these local rules, created after they are set.
        internal async Task<SessionOwner> Agent(string name, JsonArray? rules, string session = "s")
        {
            await F.Manager.CreateAgentAsync(name, createMainSession: false);
            if (rules is not null)
                await F.Manager.SetAgentRulesAsync(name, rules);
            return await F.Manager.CreateNamedAsync(name, session, null, null);
        }

        internal SessionToolExecutor Tools(SessionOwner owner)
        {
            var tools = new SessionToolExecutor(new WorkspaceTools(F.Work), owner, F.Manager, F.Registry);
            tools.BeginTurn();
            return tools;
        }

        internal async Task<JsonObject> Ctl(SessionOwner owner, string command, JsonObject? values = null)
        {
            var args = new JsonObject { ["command"] = command };
            if (values is not null)
                args["values"] = values;
            return (
                await Tools(owner)
                    .ExecuteAsync(
                        new JsonObject
                        {
                            ["id"] = "skill-access",
                            ["name"] = "ctl",
                            ["args"] = args,
                        },
                        default
                    )
            )!.AsObject();
        }

        internal async Task<string[]> Listed(SessionOwner owner, string command = "skill list")
        {
            var result = await Ctl(owner, command);
            Assert.True(result["skills"] is JsonArray, result.ToJsonString());
            return result["skills"]!.AsArray().Select(skill => SessionWait.Text(skill!["name"])!).ToArray();
        }

        public async ValueTask DisposeAsync()
        {
            await F.DisposeAsync();
            Skills.Dispose();
        }
    }

    private static string Snapshot(SessionOwner owner) =>
        SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]) ?? "";

    private static async Task<string> Rebuilt(Host host, SessionOwner owner)
    {
        Assert.NotNull(await host.F.Manager.RefreshSnapshotAsync(owner));
        return Snapshot(owner);
    }

    private static string Line(string name, string? run = null) =>
        $"  <skill><name>{name}</name><description>A synthetic skill.</description><source>global</source>"
        + (run is null ? "" : $"<run>{run}</run>")
        + "</skill>\n";

    // The catalog section the snapshot carries, from its first line to its closing tag.
    private static string? CatalogOf(string snapshot)
    {
        var start = snapshot.IndexOf("The following skills provide", StringComparison.Ordinal);
        if (start < 0)
            return null;
        const string end = "</available_skills>\n";
        return snapshot[start..(snapshot.IndexOf(end, start, StringComparison.Ordinal) + end.Length)];
    }

    private static string FullCatalog(params string[] lines) =>
        "The following skills provide specialized instructions for specific tasks.\nWhen a task matches a skill's description, run `ctl skill load <name>`\nto load its full instructions and resource list.\n"
        + (lines.Any(line => line.Contains("<run>", StringComparison.Ordinal))
            ? AgentMemory.RunnableSkillsSentence + "\n"
            : "")
        + "Read listed resources only when the loaded skill or current task needs them:\n<available_skills>\n"
        + string.Concat(lines)
        + "</available_skills>\n";

    [Fact]
    public async Task An_unrestricted_Agent_keeps_the_exact_catalog_bytes()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        host.Write("plain", "", entry: null);
        var owner = await host.Agent("free", null);
        Assert.Equal(FullCatalog(Line("demo", "Returns one."), Line("plain")), CatalogOf(Snapshot(owner)));
        // A policy that allows skill and run_skill outright changes nothing either.
        await host.Policy(
            "version: 1\ndefaultAction: deny\nrules:\n- id: skills\n  action: allow\n  match:\n    tool: {source: builtin, name: [skill, run_skill]}\n"
        );
        Assert.Equal(FullCatalog(Line("demo", "Returns one."), Line("plain")), CatalogOf(await Rebuilt(host, owner)));
    }

    [Fact]
    public async Task A_template_restricted_Agent_lists_skills_without_run_and_agrees_with_dispatch()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        host.Write("plain", "", entry: null);
        var worker = await host.Agent("worker", RestrictedWorkerRules());
        var snapshot = Snapshot(worker);
        Assert.Equal(FullCatalog(Line("demo"), Line("plain")), CatalogOf(snapshot));
        Assert.DoesNotContain(AgentMemory.RunnableSkillsSentence, snapshot);
        // What the catalog offers is what the rules let the worker do.
        Assert.Equal(["demo", "plain"], await host.Listed(worker));
        Assert.Contains("Skill: demo", SessionWait.Text((await host.Ctl(worker, "skill load demo"))["output"]));
        Assert.Equal("tool_authorization_denied", (await host.Ctl(worker, "skill run demo")).FailureCode());
        Assert.Null((await host.Ctl(worker, "skill run demo --help"))["output"]);
    }

    [Fact]
    public async Task A_name_deny_hides_one_skill_and_an_ask_keeps_it_listed()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        host.Write("hidden");
        host.Write("asked");
        var owner = await host.Agent(
            "limited",
            Rules(
                """
                [
                  {"id":"no-hidden","tool":{"source":"builtin","name":["skill","run_skill"]},"args":{"skillName":"hidden"},"action":"deny"},
                  {"id":"ask-asked","tool":{"source":"builtin","name":["skill","run_skill"]},"args":{"skillName":"asked"},"action":"ask"},
                  {"id":"skills","tool":{"source":"builtin","name":["skill","run_skill"]},"action":"allow"},
                  {"id":"rest","action":"deny"}
                ]
                """
            )
        );
        Assert.Equal(
            FullCatalog(Line("asked", "Returns one."), Line("demo", "Returns one.")),
            CatalogOf(Snapshot(owner))
        );
        Assert.Equal(["asked", "demo"], await host.Listed(owner));
    }

    [Fact]
    public async Task Run_is_shown_by_the_skill_name_and_unknown_run_arguments_never_hide_it()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        host.Write("other");
        var owner = await host.Agent(
            "runner",
            Rules(
                """
                [
                  {"id":"no-background","tool":{"source":"builtin","name":"run_skill"},"args":{"mode":"background"},"action":"deny"},
                  {"id":"no-other-run","tool":{"source":"builtin","name":"run_skill"},"args":{"skillName":"other"},"action":"deny"},
                  {"id":"no-other-agents","tool":{"source":"builtin","name":"run_skill"},"args":{"agentName":{"exists":true}},"action":"deny"},
                  {"id":"no-scripts","tool":{"source":"builtin","name":"run_skill"},"args":{"script":{"exists":true}},"action":"deny"}
                ]
                """
            )
        );
        Assert.Equal(FullCatalog(Line("demo", "Returns one."), Line("other")), CatalogOf(Snapshot(owner)));
    }

    [Fact]
    public async Task A_listing_for_another_Agent_probes_the_call_with_that_agentName()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        var owner = await host.Agent(
            "caller",
            Rules(
                """
                [
                  {"id":"own-skills","tool":{"source":"builtin","name":"skill"},"args":{"agentName":{"exists":false}},"action":"allow"},
                  {"id":"rest","action":"deny"}
                ]
                """
            )
        );
        Assert.Equal(["demo"], await host.Listed(owner));
        // The list call itself is decided at dispatch.
        Assert.Equal(
            "tool_authorization_denied",
            (await host.Ctl(owner, "skill list --agent-name main")).FailureCode()
        );
        await host.F.Manager.SetAgentRulesAsync(
            "caller",
            Rules(
                """
                [
                  {"id":"list","tool":{"source":"builtin","name":"skill"},"args":{"action":"list"},"action":"allow"},
                  {"id":"own-skills","tool":{"source":"builtin","name":"skill"},"args":{"agentName":{"exists":false}},"action":"allow"},
                  {"id":"rest","action":"deny"}
                ]
                """
            )
        );
        Assert.Equal(["demo"], await host.Listed(owner));
        Assert.Empty(await host.Listed(owner, "skill list --agent-name main"));
    }

    [Fact]
    public async Task An_unavailable_global_policy_leaves_the_catalog_unfiltered()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        var worker = await host.Agent("worker", RestrictedWorkerRules());
        Assert.Equal(FullCatalog(Line("demo")), CatalogOf(Snapshot(worker)));
        await host.Policy("version: 1\nrules: [unclosed\n");
        Assert.Equal(FullCatalog(Line("demo", "Returns one.")), CatalogOf(await Rebuilt(host, worker)));
        // Every call still fails closed meanwhile.
        Assert.NotNull((await host.Ctl(worker, "skill list"))["error"]);
    }

    [Fact]
    public async Task Unreadable_Agent_rules_give_an_empty_catalog()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        var worker = await host.Agent("worker", RestrictedWorkerRules());
        await host.F.Manager.ShutdownAsync();
        await host.F.Manager.DisposeAsync();
        var path = Path.Combine(host.F.Data, "state", "agents.json");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        document["metadata"]!["worker"]!["rules"] = Rules(
            """[{"id":"x","action":"allow","match":{"futureSelector":true}}]"""
        );
        await File.WriteAllTextAsync(path, document.ToJsonString());
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        host.F.Manager = new(host.F.Data, host.F.Work, options, HostModels.ForTest(options), host.Skills.Path);
        await host.F.Manager.LoadMainHostAsync();
        var reopened = await host.F.Manager.RequiredAsync(worker.Id);
        var snapshot = await Rebuilt(host, reopened);
        Assert.Null(CatalogOf(snapshot));
        Assert.Contains("--- DIRECTORIES ---", snapshot);
    }
}
