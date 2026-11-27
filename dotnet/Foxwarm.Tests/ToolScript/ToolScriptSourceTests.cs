using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptSourceTests
{
    internal static string BundledSkills()
    {
        var repository = new DirectoryInfo(AppContext.BaseDirectory);
        while (
            repository is not null
            && !File.Exists(
                Path.Combine(repository.FullName, "skills", "toolscript-automation", "SKILL.md")
            )
        )
            repository = repository.Parent;
        Assert.NotNull(repository);
        return Path.Combine(repository.FullName, "skills");
    }

    // The bundled example run with `skill run --script`, paused for agent input and continued;
    // it reads its own files through `skill load`, so no path argument is needed.
    internal static async Task AssertBundledExampleRuns(
        Func<string, JsonObject, Task<JsonObject>> call,
        string skills
    )
    {
        var examples = Path.Combine(skills, "toolscript-automation", "examples");
        var loaded = await call(
            "skill",
            new JsonObject { ["action"] = "load", ["skillName"] = "toolscript-automation" }
        );
        Assert.True(loaded["error"] is null, loaded.ToJsonString());
        Assert.Contains("examples/automation_basic.py", SessionWait.Text(loaded["output"]));
        var waiting = await call(
            "ctl",
            new JsonObject
            {
                ["command"] = "skill run toolscript-automation --script examples/automation_basic.py",
            }
        );
        Assert.True(SessionWait.Text(waiting["status"]) == "waiting", waiting.ToJsonString());
        Assert.Equal("agent", SessionWait.Text(waiting["waitingReason"]));
        var completed = await call(
            "continue_script",
            new JsonObject
            {
                ["runId"] = waiting["runId"]!.DeepClone(),
                ["continuationId"] = waiting["continuationId"]!.DeepClone(),
                ["input"] = "EXAMPLE_OK",
            }
        );
        Assert.True(SessionWait.Text(completed["status"]) == "completed", completed.ToJsonString());
        Assert.Equal("EXAMPLE_OK", SessionWait.Text(completed["result"]?["label"]));
        var listing = SessionWait.Text(completed["result"]?["listingPreview"])!;
        Assert.StartsWith("DIRECTORY: toolscript-automation/examples/ ", listing);
        Assert.Contains("- examples/automation_basic.py", listing);
        var documentation = await File.ReadAllTextAsync(Path.Combine(examples, "README.md"));
        Assert.Equal(
            documentation[..160].Replace("\n", " "),
            SessionWait.Text(completed["result"]?["documentationExcerpt"])
        );
    }

    [Fact]
    public async Task Bundled_automation_skill_loads_and_runs_its_example_with_normal_host_calls()
    {
        var skills = BundledSkills();
        await using var f = await ScriptFixture.Create(skills);
        await AssertBundledExampleRuns(f.Call, skills);
    }

    [Theory]
    [InlineData("run_script", false)]
    [InlineData("start_toolscript_run", true)]
    public async Task Main_file_source_is_trimmed_captured_before_authorization_and_nested_calls_keep_live_owner_cwd(
        string name,
        bool unified
    )
    {
        await using var f = await ScriptFixture.Create();
        var oldCwd = Path.Combine(f.Work, "old");
        var newCwd = Path.Combine(f.Work, "new");
        Directory.CreateDirectory(oldCwd);
        Directory.CreateDirectory(newCwd);
        await File.WriteAllTextAsync(
            Path.Combine(oldCwd, "source.py"),
            "return call_tool('read', {'filePath':'nested.txt'})['content']"
        );
        await File.WriteAllTextAsync(Path.Combine(newCwd, "source.py"), "return 'wrong source'");
        await File.WriteAllTextAsync(Path.Combine(oldCwd, "nested.txt"), "stale nested cwd");
        await File.WriteAllTextAsync(Path.Combine(newCwd, "nested.txt"), "live nested cwd");
        await f.Owner.UpdateCwdAsync(oldCwd);
        var policyPath = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(policyPath, "version: 1\nrules: null\n");
        var paused = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var authority = new ToolAuthorizationAuthority(
            f.Data,
            retryDelay: async token =>
            {
                paused.TrySetResult();
                await release.Task.WaitAsync(token);
            }
        );
        typeof(SessionManager)
            .GetField("authorization", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(f.Manager, authority);
        var args = new JsonObject { ["node"] = "master", ["filePath"] = "  source.py  " };
        using var batch = f.Tools.CaptureDirectExecSegment();
        var operation = unified
            ? f.Call(
                "ctl",
                CtlTestArgs.Unified(new JsonObject { ["toolId"] = "builtin:" + name, ["args"] = args })
            )
            : f.Call(name, args);
        try
        {
            await paused.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await f.Owner.UpdateCwdAsync(newCwd);
            // Starter path authority must remain the captured old directory, not the new live cwd.
            await File.WriteAllTextAsync(
                policyPath,
                "version: 1\ndefaultAction: allow\nrules:\n- id: captured-starter\n  action: deny\n  match:\n    tool: {source: builtin, name: [run_script, start_toolscript_run]}\n    path: {anyNotWithin: "
                    + JsonValue.Create(oldCwd)!.ToJsonString()
                    + "}\n"
            );
        }
        finally
        {
            release.TrySetResult();
        }
        var result = await operation.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(result["error"] is null, result.ToJsonString());
        Assert.Equal("live nested cwd", result["result"]!.GetValue<string>());
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            result["runId"]!.GetValue<string>(),
            default
        );
        Assert.Equal("master", record!["sourceNode"]!.GetValue<string>());
        Assert.Equal(Path.Combine(oldCwd, "source.py"), record["scriptPath"]!.GetValue<string>());
    }

    [Fact]
    public async Task Inline_selector_is_rejected_and_source_capable_starters_are_visible_with_an_unknown_target()
    {
        await using var f = await ScriptFixture.Create();
        foreach (var name in new[] { "run_script", "start_toolscript_run" })
        {
            foreach (
                var node in new JsonNode?[]
                {
                    null,
                    JsonValue.Create("current"),
                    JsonValue.Create("master"),
                }
            )
            {
                var rejected = await f.Call(
                    name,
                    new JsonObject { ["code"] = "return 1", ["node"] = node }
                );
                Assert.NotNull(rejected["error"]);
            }
        }
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\ndefaultAction: allow\nrules:\n- id: current-only\n  action: deny\n  match:\n    tool: {source: builtin, name: [run_script, start_toolscript_run]}\n    targetNode: master\n"
        );
        f.Manager.Authorization.Invalidate();
        Assert.True(f.Manager.ToolVisible(f.Owner, "builtin", "run_script"));
        Assert.True(f.Manager.ToolVisible(f.Owner, "builtin", "start_toolscript_run"));
        var found = await f.Call(
            "ctl",
            CtlTestArgs.Search(new JsonObject { ["query"] = "run_script", ["sources"] = new JsonArray("builtin") })
        );
        Assert.True(
            CtlTestArgs.ListsBuiltin(found["output"]!.GetValue<string>(), "run_script"),
            found["output"]!.GetValue<string>()
        );
        var denied = await f.Call("run_script", new JsonObject { ["filePath"] = "missing.py" });
        Assert.Equal("tool_authorization_denied", denied.FailureCode()!);
    }
}
