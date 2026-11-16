using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Upgrade warnings for automation and text written for search_tools and call_tool. They never
// block selection and never print script code, rule bodies, memory text or secrets.
public sealed class SessionUpgradeToolNamesTests
{
    [Fact]
    public async Task Old_tool_names_in_scripts_rules_memory_and_skills_are_warnings_naming_their_record()
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        var scriptFile = Path.Combine(temp.Path, "saved.py");
        await File.WriteAllTextAsync(scriptFile, "return call_tool('search_tools', {})\n");
        await File.WriteAllTextAsync(
            Path.Combine(state, "timers.json"),
            new JsonObject
            {
                ["timers"] = new JsonArray(
                    Timer("inline", new JsonObject { ["code"] = "secret_marker = 1\ncall_tool('search_tools', {'query': 'x'})" }),
                    Timer("saved", new JsonObject { ["filePath"] = scriptFile }),
                    Timer("current", new JsonObject { ["code"] = "return call_tool('read_memory', {'filePath': 'a.md'})" })
                ),
            }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(state, "tool-authorization.yaml"),
            """
            version: 1
            rules:
            - {id: no-discovery, tool: {source: builtin, name: search_tools}, action: deny}
            - {id: no-crop, tool: {source: builtin, name: image_crop}, action: deny}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(state, "agents.json"),
            """{"worker":{"rules":[{"id":"wrapper","tool":{"source":"builtin","name":"call_tool"},"action":"allow"},{"action":"deny"}]}}"""
        );
        foreach (var agent in new[] { "main", "worker" })
            Directory.CreateDirectory(Path.Combine(temp.Path, "agents", agent, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "agents/main/memory/MEMORY.md"),
            "Look tools up with search_tools and run them with call_tool. secret_marker\n"
        );
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "agents/worker/memory/MEMORY.md"), "Use ctl.\n");
        Directory.CreateDirectory(Path.Combine(temp.Path, "agents/main/skills/report"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "agents/main/skills/report/SKILL.md"),
            "Run `call_tool('read_memory', ...)`.\n"
        );
        var access = new AccessConfiguration(
            JsonNode.Parse(
                """
                {"access":{"identities":{"hook":{"token":"hook-token-0123456789abcdef","surfaces":{"webhook":{
                  "session":"main/hooks","verify":"bearer","action":"toolscript",
                  "script":{"code":"secret_marker = 2\nreturn call_tool('search_tools', {})"}}}}}}}
                """
            )!.AsObject()
        );

        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path), access);
        var warnings = report
            .Issues.Where(issue => issue.Category == "tool names")
            .Select(issue => issue.Detail)
            .ToArray();

        Assert.True(report.CanSelect);
        Assert.All(report.Issues.Where(issue => issue.Category == "tool names"), issue => Assert.False(issue.Blocking));
        Assert.Contains(warnings, text => text.StartsWith("timer \"inline\"") && text.Contains("its script calls search_tools"));
        Assert.Contains(warnings, text => text.StartsWith("timer \"saved\"") && text.Contains("script file"));
        Assert.DoesNotContain(warnings, text => text.Contains("\"current\""));
        Assert.Contains(warnings, text => text.StartsWith("webhook of access identity \"hook\""));
        Assert.Contains(warnings, text => text.StartsWith("state/tool-authorization.yaml") && text.Contains("search_tools"));
        Assert.Contains(warnings, text => text.StartsWith("state/tool-authorization.yaml") && text.Contains("`no-crop`"));
        Assert.Contains(warnings, text => text.StartsWith("rules of Agent \"worker\"") && text.Contains("call_tool"));
        Assert.Contains(warnings, text => text.Contains("\"main/memory/MEMORY.md\" mentions call_tool and search_tools"));
        Assert.Contains(warnings, text => text.Contains("\"main/skills/report/SKILL.md\" mentions call_tool"));
        Assert.DoesNotContain(warnings, text => text.Contains("worker/memory"));
        // No script code, memory text or token reaches the report.
        Assert.DoesNotContain(warnings, text => text.Contains("secret_marker") || text.Contains("hook-token"));
    }

    private static JsonObject Timer(string id, JsonObject script) =>
        new()
        {
            ["id"] = id,
            ["sessionId"] = "main/ops",
            ["action"] = "toolscript",
            ["cron"] = "* * * * *",
            ["script"] = script,
        };
}
