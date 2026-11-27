using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolActivityPreviewTests
{
    private static JsonObject Call(long seq, string id, string name, JsonObject args) =>
        new()
        {
            ["role"] = "model",
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 },
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = id,
                        ["name"] = name,
                        ["args"] = args,
                    },
                }
            ),
        };

    private static JsonObject Result(long seq, string id, string name, JsonObject value) =>
        new()
        {
            ["role"] = "tool",
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 },
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = id,
                        ["name"] = name,
                        ["response"] = value,
                    },
                }
            ),
        };

    private static string Preview(JsonObject[] rows, JsonObject? options = null) =>
        new ContextPreviewRenderer(options ?? new()).Render(
            "main/activity",
            "",
            rows.Length,
            0,
            rows
        );

    [Fact]
    public void Ctl_calls_are_named_by_command_path_without_restating_fixed_arguments()
    {
        JsonObject Ctl(string command) => new() { ["command"] = command };
        var rows = new[]
        {
            Call(1, "timers", "ctl", Ctl("timer list")),
            Call(2, "view", "ctl", Ctl("session view main/other --count 2")),
            Call(3, "rename", "ctl", Ctl("session rename \"Release notes\"")),
            Call(4, "recall", "ctl", Ctl("history recall msg#1-2")),
            Call(5, "help", "ctl", Ctl("node --help")),
        };
        var text = Preview(rows);
        Assert.Contains("timer list (#1)", text);
        Assert.Contains("session view — main/other (#2)", text);
        // A command whose path states its fixed arguments shows the rest as the card header does.
        Assert.Contains("session rename — Release notes (#3)", text);
        Assert.Contains("history recall — msg#1-2 (#4)", text);
        // Help and other front-end calls show their command.
        Assert.Contains("ctl — node --help (#5)", text);
        foreach (var concrete in new[] { "list_timers", "view_session", "update-display-name", "Z recall" })
            Assert.DoesNotContain(concrete, text);
    }

    [Fact]
    public void Ctl_calls_show_their_summary_otherwise_known_keys_or_inline_arguments()
    {
        JsonObject Ctl(string command, JsonObject? args = null, string? summary = null)
        {
            var call = new JsonObject { ["command"] = command };
            if (args is not null)
                call["values"] = new JsonObject { ["args"] = args };
            if (summary is not null)
                call["summary"] = summary;
            return call;
        }
        JsonObject Mcp() => new() { ["repo"] = "octo-org/demo", ["state"] = "open", ["perPage"] = 5 };
        var exec = new JsonObject { ["command"] = "make", ["summary"] = "Build the project" };
        var rows = new[]
        {
            Call(1, "mcp", "ctl", Ctl("tool call mcp:github/list_issues --args @args", Mcp())),
            Call(2, "mcp-summary", "ctl", Ctl("tool call mcp:github/list_issues --args @args", Mcp(), "List open issues")),
            Call(3, "builtin", "ctl", Ctl("skill load code-index")),
            Call(4, "builtin-summary", "ctl", Ctl("skill load code-index", summary: "Load the index skill")),
            Call(5, "both", "ctl", Ctl("tool call node:worker/exec --args @args", exec, "Run make on the worker")),
            Call(6, "no-key", "ctl", Ctl("session list --count 3")),
            Call(7, "query", "ctl", Ctl("tool call mcp:search/find --args @args", new() { ["query"] = "foxwarm", ["limit"] = 2 })),
            Call(8, "long", "ctl", Ctl("tool call mcp:github/create --args @args", new() { ["body"] = new string('x', 400) })),
        };
        var text = Preview(rows);
        Assert.Contains("list_issues — repo: octo-org/demo state: open perPage: 5 (#1)", text);
        Assert.Contains("list_issues — List open issues (#2)", text);
        Assert.Contains("skill load — code-index (#3)", text);
        Assert.Contains("skill load — Load the index skill (#4)", text);
        Assert.Contains("exec — Build the project (#5)", text);
        Assert.DoesNotContain("Run make on the worker", text);
        // A sole argument shows only its value, as in the card header.
        Assert.Contains("session list — 3 (#6)", text);
        Assert.Contains("find — query: foxwarm limit: 2 (#7)", text);
        Assert.Matches(@"create — x{190,199}… \(#8\)", text);

        Assert.Equal(
            "repo: octo-org/demo state: open perPage: 5",
            SessionToolExecutor.ToolArgsPreview("ctl", Ctl("tool call mcp:github/list_issues --args @args", Mcp()))
        );
        Assert.Equal(
            "List open issues",
            SessionToolExecutor.ToolArgsPreview("ctl", Ctl("tool call mcp:github/list_issues --args @args", Mcp(), "List open issues"))
        );
        Assert.Equal("make", SessionToolExecutor.ToolArgsPreview("ctl", Ctl("tool call node:worker/exec --args @args", new() { ["command"] = "make" })));
    }

    [Fact]
    public void Names_preserve_distinct_purposes_pair_by_id_and_keep_output_out_of_activity()
    {
        var rows = new[]
        {
            Call(
                1,
                "first",
                "exec",
                new()
                {
                    ["command"] = "export SECRET=setup; do-work",
                    ["summary"] = "Check source\nlayout",
                }
            ),
            Call(
                2,
                "second",
                "call_tool",
                new()
                {
                    ["toolId"] = "node:provider/worker/exec",
                    ["argsJson"] = "{\"command\":\"compile\",\"summary\":\"Compile project\"}",
                }
            ),
            Result(
                3,
                "second",
                "call_tool",
                new() { ["error"] = new JsonObject { ["message"] = "compiler unavailable" } }
            ),
            Result(
                4,
                "first",
                "exec",
                new() { ["output"] = "large-output-secret " + new string('x', 5000) }
            ),
            Call(5, "legacy", "exec", new() { ["command"] = "export WORK=owned;\nprintf legacy" }),
        };
        Assert.Equal(
            "group/tool",
            ToolActivity.Target("call_tool", new() { ["toolId"] = "mcp:server/group/tool" }).Name
        );
        var original = rows.Select(row => row.ToJsonString()).ToArray();
        var text = Preview(rows);
        Assert.Contains("exec — Check source layout", text);
        Assert.Contains("exec — Compile project [error: compiler unavailable]", text);
        Assert.Contains("exec — export WORK=owned; printf legacy", text);
        Assert.DoesNotContain("large-output-secret", text);
        Assert.DoesNotContain("SECRET=setup", text);
        Assert.DoesNotContain("×", text);
        Assert.DoesNotContain("call_tool", text);
        Assert.Equal(3, text.Split('\n').Count(line => line.Contains("exec —")));
        Assert.Equal(1, text.Split("ctl history recall ").Length - 1);
        Assert.Contains("(#2/#3)", text);
        Assert.Equal(original, rows.Select(row => row.ToJsonString()));

        var filtered = Preview(rows, new() { ["contentFilter"] = "large-output-secret" });
        Assert.Contains("showing 1 of 5", filtered);
        Assert.Contains("Matched in omitted tool call/result content", filtered);
        Assert.DoesNotContain("large-output-secret", filtered);
        var full = Preview(rows, new() { ["toolDetail"] = "full", ["previewLength"] = 20000 });
        Assert.Contains("large-output-secret", full);
        Assert.Contains("SECRET=setup", full);
        var snippets = Preview(rows, new() { ["toolDetail"] = "snippets" });
        Assert.Contains("large-output-secret", snippets);
        Assert.True(snippets.Length < full.Length);
    }

    [Fact]
    public void Activity_layout_uses_second_precision_UTC_and_one_timestamp_per_message()
    {
        var mixed = Call(5, "mixed", "exec", new() { ["summary"] = "Inspect mixed message" });
        mixed["parts"]!.AsArray().Insert(0, new JsonObject { ["text"] = "Check the next source." });
        var output = Preview([
            Call(1, "first", "exec", new() { ["summary"] = "Inspect source" }),
            Result(2, "first", "exec", new() { ["output"] = "first result" }),
            Call(3, "second", "exec", new() { ["command"] = "git diff" }),
            Result(4, "second", "exec", new() { ["output"] = "second result" }),
            mixed,
            Result(6, "mixed", "exec", new() { ["output"] = "mixed result" }),
        ]);
        Assert.Contains("1970-01-01 00:00:01Z exec", output);
        Assert.Contains("(#1/#2)\n1970-01-01 00:00:03Z exec", output);
        Assert.Contains("(#3/#4)\n\n[#5 time 1970-01-01 00:00:05Z] model:", output);
        Assert.Contains("Check the next source.\nexec — Inspect mixed message (#5/#6)", output);
        Assert.Equal(1, output.Split("1970-01-01 00:00:05Z").Length - 1);
        Assert.Contains("(#5/#6)\n\nDetails:", output);
    }

    [Fact]
    public void Boundary_results_do_not_invent_a_running_call_and_duplicate_ids_do_not_hide_operations()
    {
        var result = Result(10, "id", "exec", new() { ["output"] = "finished" });
        var boundary = Preview([result]);
        Assert.Contains("result only", boundary);
        Assert.DoesNotContain("running", boundary);
        Assert.DoesNotContain("partial/unpaired", boundary);
        var duplicate = Preview([
            Call(1, "id", "exec", new() { ["command"] = "first" }),
            Call(2, "id", "exec", new() { ["command"] = "second" }),
            result,
        ]);
        Assert.Contains("exec — first", duplicate);
        Assert.Contains("exec — second", duplicate);
        Assert.Contains("result only", duplicate);
    }

    [Fact]
    public void Only_the_runtime_identified_pending_call_is_marked_running()
    {
        var rows = new[]
        {
            (0, Call(1, "old", "exec", new() { ["command"] = "old command" })),
            (
                1,
                Call(
                    2,
                    "live",
                    "exec",
                    new() { ["summary"] = "Compile source", ["command"] = "compile" }
                )
            ),
        };
        var runtime = new JsonObject
        {
            ["state"] = "running-tool",
            ["tool"] = new JsonObject { ["id"] = "live" },
        };
        var page = new SessionViewPage(0, 2, 2, 2, 1, runtime, rows);
        var renderer = new ContextPreviewRenderer(new());
        var output = renderer.RenderLive("main/activity", page, new());
        Assert.Contains("Compile source [running]", output);
        Assert.DoesNotContain("old command [running]", output);
        runtime["state"] = "idle";
        Assert.DoesNotContain("[running]", renderer.RenderLive("main/activity", page, new()));
    }

    [Fact]
    public void Budget_keeps_footer_once_and_does_not_turn_names_into_result_excerpts()
    {
        var rows = Enumerable
            .Range(1, 40)
            .Select(n =>
                Call(
                    n,
                    "id" + n,
                    "exec",
                    new()
                    {
                        ["command"] = "setup " + new string('x', 400),
                        ["summary"] = "Inspect source " + n,
                    }
                )
            )
            .ToArray();
        var text = Preview(rows, new() { ["previewLength"] = 1000 });
        Assert.True(text.Length <= 1000);
        Assert.Contains("Inspect source 1", text);
        Assert.Contains("not displayed", text);
        Assert.Equal(1, text.Split("ctl history recall ").Length - 1);
    }

    [Fact]
    public async Task Model_schemas_require_summary_but_direct_unified_and_script_automation_keep_old_calls()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        foreach (var name in new[] { "exec", "run_script" })
        {
            var definition = f
                .Manager.ModelDefinitions(f.Owner)
                .OfType<JsonObject>()
                .Single(item => SessionWait.Text(item["name"]) == name);
            Assert.Contains(
                "summary",
                definition["parameters"]!["required"]!.AsArray().Select(SessionWait.Text)
            );
        }
        foreach (var summarized in new[] { false, true })
        {
            var args = new JsonObject
            {
                ["command"] = "printf summary-test",
                ["cwd"] = f.Work,
                ["timeout"] = 5,
            };
            if (summarized)
                args["summary"] = "Print a test marker";
            foreach (var unified in new[] { false, true })
            {
                var response = await f.Call(
                    unified ? "ctl" : "exec",
                    unified
                        ? CtlTestArgs.Unified(
                            new JsonObject
                            {
                                ["toolId"] = "node:master/exec",
                                ["args"] = args.DeepClone(),
                            }
                        )
                        : args
                );
                Assert.Null(response["error"]);
                Assert.Contains("summary-test", SessionWait.Text(response["output"]));
            }
            var script = new JsonObject
            {
                ["code"] =
                    "return call_tool('node:master/exec', {'command': 'printf nested-marker'})",
            };
            if (summarized)
                script["summary"] = "Run a nested command";
            var completed = await f.Call("run_script", script);
            Assert.Equal("completed", SessionWait.Text(completed["status"]));
            Assert.Contains("nested-marker", completed["result"]!.ToJsonString());
        }
        Assert.Equal(
            "Inspect source",
            SessionToolExecutor.ToolArgsPreview(
                "exec",
                new() { ["summary"] = "Inspect source", ["command"] = "setup; inspect" }
            )
        );
        Assert.Equal(
            "Inspect source",
            SessionToolExecutor.ToolArgsPreview(
                "call_tool",
                new()
                {
                    ["toolId"] = "node:master/exec",
                    ["args"] = new JsonObject { ["summary"] = "Inspect source" },
                }
            )
        );
        Assert.Equal(
            "Inspect source",
            SessionToolExecutor.ToolArgsPreview(
                "ctl",
                CtlTestArgs.Unified(
                    new()
                    {
                        ["toolId"] = "node:master/exec",
                        ["args"] = new JsonObject { ["summary"] = "Inspect source" },
                    }
                )
            )
        );
    }
}
