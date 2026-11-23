using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

// `ctl skill run`: a runnable skill's entry runs as the caller's inline ToolScript run.
public sealed class ToolScriptSkillRunTests
{
    private static bool Supported => OperatingSystem.IsLinux() && MontyWorker.IsSupported;

    private const string DemoRun =
        "run:\n  entry: scripts/run.py\n  effect: Reads one file and answers.\n  args:\n    type: object\n    additionalProperties: false\n    required: [question]\n    properties:\n      question: {type: string, description: The question to answer.}\n      file: {type: string, description: File to read.}\n";

    private sealed class Skilled : IAsyncDisposable
    {
        internal readonly TempDirectory Skills = new();
        internal ScriptFixture F = null!;

        internal static async Task<Skilled> Create()
        {
            var skilled = new Skilled();
            skilled.F = await ScriptFixture.Create(skilled.Skills.Path);
            return skilled;
        }

        internal string Write(string name, string frontmatter, string code) =>
            RunnableSkillTests.WriteSkill(Skills.Path, name, frontmatter, code: code);

        internal Task<JsonObject> Run(string command, JsonObject? values = null, SessionToolExecutor? tools = null)
        {
            var args = new JsonObject { ["command"] = command };
            if (values is not null)
                args["values"] = values;
            return Call(tools ?? F.Tools, "ctl", args);
        }

        internal async Task<int> Runs() =>
            (await F.Manager.ToolScript.Store.ListAsync(F.Owner.Id, 200, null, default)).Count;

        public async ValueTask DisposeAsync()
        {
            await F.DisposeAsync();
            Skills.Dispose();
        }
    }

    private static async Task<JsonObject> Call(SessionToolExecutor tools, string name, JsonObject args) =>
        (
            await tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "skill-run",
                    ["name"] = name,
                    ["args"] = args.DeepClone(),
                },
                default
            )
        )!.AsObject();

    [Fact]
    public async Task An_entry_runs_inline_with_its_args_and_records_its_skill_provenance()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        var directory = s.Write(
            "demo",
            DemoRun,
            "print('hi')\nreturn {'q': args['question'], 'read': call_tool('read', {'filePath': args['file']})['content']}\n"
        );
        await File.WriteAllTextAsync(Path.Combine(s.F.Work, "note.txt"), "note body");
        var result = await s.Run(
            "skill run demo --args @a",
            new JsonObject { ["a"] = new JsonObject { ["question"] = "why", ["file"] = Path.Combine(s.F.Work, "note.txt") } }
        );
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal("why", SessionWait.Text(result["result"]!["q"]));
        Assert.Contains("note body", SessionWait.Text(result["result"]!["read"]));
        Assert.Equal("hi\n", SessionWait.Text(result["stdout"]));
        var record = await s.F.Manager.ToolScript.Store.ReadAsync(SessionWait.Text(result["runId"])!, default);
        var entry = Path.Combine(directory, "scripts", "run.py");
        Assert.True(
            JsonNode.DeepEquals(
                new JsonObject
                {
                    ["name"] = "demo",
                    ["sourceType"] = "global",
                    ["agent"] = null,
                    ["entry"] = "scripts/run.py",
                    ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(entry))),
                },
                record!["sourceSkill"]
            ),
            record["sourceSkill"]?.ToJsonString()
        );
        Assert.Equal(entry, SessionWait.Text(record["scriptPath"]));
        Assert.Equal("run.py", SessionWait.Text(record["scriptName"]));
        // The nested read is an ordinary subcall of the run.
        Assert.Contains("read", record["executedTools"]!.AsArray().Select(call => SessionWait.Text(call)));
    }

    [Fact]
    public async Task Argument_and_skill_errors_fail_before_a_run_record_exists()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        s.Write("demo", DemoRun, "return 1\n");
        s.Write("plain", "", "return 1\n");
        s.Write("broken", "run:\n  entry: scripts/absent.py\n  effect: Never runs.\n", "return 1\n");
        foreach (
            var (values, expected) in new (JsonObject, string)[]
            {
                (new JsonObject(), "`args.question`"),
                (new JsonObject { ["question"] = 3 }, "`args.question`"),
                (new JsonObject { ["question"] = "q", ["extra"] = true }, "`args.extra`"),
            }
        )
        {
            var failed = await s.Run("skill run demo --args @a", new JsonObject { ["a"] = values });
            Assert.True(failed["error"] is not null, failed.ToJsonString());
            var message = SessionWait.Text(failed["error"])!;
            Assert.Contains(expected, message);
            Assert.Contains("ctl skill run demo --help", message);
        }
        Assert.Contains("ctl skill load plain", SessionWait.Text((await s.Run("skill run plain"))["error"]));
        Assert.Contains("`run`", SessionWait.Text((await s.Run("skill run broken"))["error"]));
        Assert.Contains("not found", SessionWait.Text((await s.Run("skill run absent"))["error"]));
        Assert.Equal(0, await s.Runs());
    }

    [Fact]
    public async Task Help_shows_the_skills_effect_and_arguments_from_its_frontmatter()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        s.Write("demo", DemoRun, "return 1\n");
        s.Write("plain", "", "return 1\n");
        var help = SessionWait.Text((await s.Run("skill run demo --help"))["output"])!;
        // The skill's own frontmatter copy reaches the help unchanged.
        Assert.Contains("Reads one file and answers.", help);
        Assert.Contains("The question to answer.", help);
        Assert.Contains("File to read.", help);
        Assert.True(help.IndexOf("question", StringComparison.Ordinal) < help.IndexOf("file (", StringComparison.Ordinal));
        Assert.Contains("ctl skill load plain", SessionWait.Text((await s.Run("skill run plain --help"))["error"]));
        Assert.Equal(0, await s.Runs());
    }

    [Fact]
    public async Task Policy_gates_the_run_and_each_nested_call_but_not_a_master_read_of_the_entry()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        s.Write(
            "demo",
            "run:\n  entry: scripts/run.py\n  effect: Tries a read.\n",
            "try:\n    call_tool('read', {'filePath': 'x.txt'})\n    nested = 'allowed'\nexcept Exception as error:\n    nested = str(error)\nreturn {'ran': True, 'nested': nested}\n"
        );
        s.Write("other", "run:\n  entry: scripts/run.py\n  effect: Returns.\n", "return 'other ran'\n");
        var policy = Path.Combine(s.F.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            "version: 1\ndefaultAction: allow\nrules:\n- id: no-master-read\n  action: deny\n  match:\n    tool: {source: node, name: read}\n    targetNode: master\n"
        );
        s.F.Manager.Authorization.Invalidate();
        // The entry is disclosed through the skill subsystem, not a read on master.
        var ran = await s.Run("skill run demo");
        Assert.True(SessionWait.Text(ran["status"]) == "completed", ran.ToJsonString());
        Assert.True(ran["result"]!["ran"]!.GetValue<bool>());
        Assert.Contains("no-master-read", SessionWait.Text(ran["result"]!["nested"]));
        await File.AppendAllTextAsync(
            policy,
            "- id: no-demo\n  action: deny\n  match:\n    tool: {source: builtin, name: run_skill}\n    args: {skillName: demo}\n"
        );
        s.F.Manager.Authorization.Invalidate();
        var before = await s.Runs();
        var denied = await s.Run("skill run demo");
        Assert.Equal("tool_authorization_denied", denied.FailureCode());
        Assert.Contains("no-demo", denied.ToJsonString());
        Assert.Equal(before, await s.Runs());
        Assert.Equal("other ran", (await s.Run("skill run other"))["result"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_budget_pause_continues_from_the_snapshot_even_after_the_entry_changes()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        var directory = s.Write(
            "sleeper",
            "run:\n  entry: scripts/run.py\n  effect: Sleeps.\n  timeoutSecs: 0.4\n",
            "import time\ntime.sleep(1)\nreturn 'first'\n"
        );
        var paused = await s.Run("skill run sleeper");
        Assert.True(SessionWait.Text(paused["status"]) == "waiting", paused.ToJsonString());
        Assert.Equal("timeout", SessionWait.Text(paused["waitingReason"]));
        await File.WriteAllTextAsync(Path.Combine(directory, "scripts", "run.py"), "return 'second'\n");
        var done = await Call(
            s.F.Tools,
            "continue_script",
            new JsonObject
            {
                ["runId"] = paused["runId"]!.DeepClone(),
                ["continuationId"] = paused["continuationId"]!.DeepClone(),
                ["timeoutSecs"] = 10,
            }
        );
        Assert.True(SessionWait.Text(done["status"]) == "completed", done.ToJsonString());
        Assert.Equal("first", done["result"]!.GetValue<string>());
        // A new run reads the changed entry.
        Assert.Equal("second", (await s.Run("skill run sleeper"))["result"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_background_entry_detaches_and_reports_its_completion_once()
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        var release = Path.Combine(s.F.Manager.IdentityWorkspace(s.F.Owner)!.ToolDirectory, "release");
        s.Write(
            "slow",
            "run:\n  entry: scripts/run.py\n  effect: Waits for a release file.\n  mode: background\n  timeoutSecs: 1\n",
            "call_tool('exec', {'command': "
                + JsonSerializer.Serialize($"for n in $(seq 1 1500); do test -f '{release}' && break; sleep 0.02; done")
                + ", 'timeout': 60})\nreturn {'done': True}\n"
        );
        var receipt = await s.Run("skill run slow");
        Assert.True(SessionWait.Text(receipt["status"]) == "running", receipt.ToJsonString());
        var runId = SessionWait.Text(receipt["runId"])!;
        Assert.True(s.F.Manager.ToolScript.IsDetached(s.F.Owner.Id, runId));
        await File.WriteAllTextAsync(release, "go");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        int Events() =>
            s.F.Owner.Entry.WithState(state =>
                state.Queue.Count(item => SessionWait.Text(item.OpenFields?["execId"]) == runId)
            );
        while (Events() == 0)
            await Task.Delay(20, deadline.Token);
        while (s.F.Manager.ToolScript.IsDetached(s.F.Owner.Id, runId))
            await Task.Delay(20, deadline.Token);
        await Task.Delay(100);
        Assert.Equal(1, Events());
        // The caller may still choose foreground for the same skill.
        File.Delete(release);
        await File.WriteAllTextAsync(release, "go");
        var foreground = await s.Run("skill run slow --mode foreground --timeout-secs 30");
        Assert.True(SessionWait.Text(foreground["status"]) == "completed", foreground.ToJsonString());
    }

    private static SessionToolExecutor WaitDispatcher(ScriptFixture f)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (var item in ToolScriptToolDefinitions.Definitions().Concat(UnifiedToolDefinitions.All()))
            definitions.Add(item?.DeepClone());
        definitions.Add(WaitToolDefinitions.Definition());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        tools.BeginTurn();
        return tools;
    }

    [Theory]
    [InlineData("top-level")]
    [InlineData("nested-last")]
    [InlineData("nested-then-call")]
    public async Task A_wait_that_ends_an_entry_reaches_the_turn_only_as_the_last_host_call(string shape)
    {
        if (!Supported)
            return;
        await using var s = await Skilled.Create();
        s.Write(
            "waiter",
            "run:\n  entry: scripts/run.py\n  effect: Waits for input.\n",
            "call_tool('wait', {'waitForInput': True})\nreturn 'armed'\n"
        );
        var after = Path.Combine(s.F.Work, "after.txt");
        await File.WriteAllTextAsync(after, "after");
        var tools = WaitDispatcher(s.F);
        var result = shape switch
        {
            "top-level" => await s.Run("skill run waiter", tools: tools),
            "nested-last" => await Call(
                tools,
                "run_script",
                new JsonObject { ["code"] = "return ctl('skill run waiter')['result']\n" }
            ),
            _ => await Call(
                tools,
                "run_script",
                new JsonObject
                {
                    ["code"] = "inner = ctl('skill run waiter')\ncall_tool('read', {'filePath': "
                        + JsonSerializer.Serialize(after)
                        + "})\nreturn inner['result']\n",
                }
            ),
        };
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal("armed", result["result"]!.GetValue<string>());
        if (shape == "nested-then-call")
            Assert.Null(s.F.Owner.WaitSnapshot());
        else
            Assert.True(s.F.Owner.WaitSnapshot()!["waitForInput"]!.GetValue<bool>());
    }
}
