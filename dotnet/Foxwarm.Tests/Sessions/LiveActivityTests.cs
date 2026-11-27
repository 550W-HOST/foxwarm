using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class LiveActivityTests
{
    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) => throw new InvalidOperationException("No model request is expected.");
    }

    private static SessionOwner Owner(SessionSnapshot? snapshot = null)
    {
        var models = HostModels.ForTest(
            new ResponsesClientOptions(new Uri("http://localhost"), "m", "a/m", "", "", 50)
        );
        var owner = new SessionOwner("s", "main", models)
        {
            Registry = new SessionRegistry(new InMemorySessionAuthorityStore(), new NoChat()),
        };
        owner.Registry.Add("s", snapshot);
        owner.EnableCommittedNotifications();
        return owner;
    }

    private static SessionOwner Busy(SessionOwner owner)
    {
        owner.Entry.WithState(state => state.Busy = true);
        return owner;
    }

    private static JsonObject Row(string role, params JsonObject[] parts) =>
        new()
        {
            ["role"] = role,
            ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray()),
        };

    private static JsonObject User(string text) => Row("user", new JsonObject { ["text"] = text });

    private static JsonObject System(string text) =>
        Row("user", new JsonObject { ["system"] = text });

    private static JsonObject Thinking(string text) => new() { ["thinking"] = text };

    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["functionCall"] = new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = args,
            },
        };

    private static JsonObject Exec(string id, string? summary) =>
        Call(
            id,
            "exec",
            summary is null
                ? new JsonObject { ["command"] = "true" }
                : new JsonObject { ["summary"] = summary, ["command"] = "true" }
        );

    private static JsonObject Model(params JsonObject[] parts) => Row("model", parts);

    private static JsonObject Result(string id) =>
        Row(
            "tool",
            new JsonObject
            {
                ["functionResponse"] = new JsonObject
                {
                    ["tool_use_id"] = id,
                    ["name"] = "exec",
                    ["response"] = new JsonObject { ["output"] = "ok" },
                },
            }
        );

    // Appends committed rows the way canonical append announces them, with seq and timestamp.
    private static void Append(SessionOwner owner, params JsonObject[] rows)
    {
        owner.Entry.WithState(state =>
        {
            foreach (var row in rows)
            {
                var meta = row["__meta"] as JsonObject ?? new JsonObject();
                var seq = state.NextMessageSeq++;
                meta["seq"] = seq;
                meta["timestamp"] = meta["timestamp"]?.DeepClone() ?? 1000 + seq;
                row["__meta"] = meta;
                state.History.Add(row);
            }
        });
        owner.Entry.InvokeHistoryAppended(rows.Select(row => (JsonObject)row.DeepClone()).ToArray());
    }

    private static JsonObject? Activity(SessionOwner owner) =>
        owner.RuntimeSnapshot()["activity"] as JsonObject;

    private static (string? Reasoning, string? Tool, string? Latest) Value(SessionOwner owner) =>
        Activity(owner) is { } activity
            ? (
                SessionWait.Text(activity["reasoning"]),
                SessionWait.Text(activity["tool"]),
                SessionWait.Text(activity["latest"])
            )
            : (null, null, null);

    private static int StateChanges(List<SessionRuntimeEvent> events) =>
        events.Count(item => item.Kind == SessionEventKind.StateChanged);

    [Fact]
    public void Reasoning_titles_follow_the_reasoning_card_first_line_heading_rule()
    {
        Assert.Equal("Last title", SessionLiveActivity.ReasoningTitle("**Title**\nBody.\n**Last title**\nBody."));
        Assert.Equal("First heading", SessionLiveActivity.ReasoningTitle("  **First heading**\nBody."));
        Assert.Equal("Only", SessionLiveActivity.ReasoningTitle("**Only**"));
        Assert.Equal("Next", SessionLiveActivity.ReasoningTitle("**First**\nBody\n**Next**"));
        foreach (
            var text in new[]
            {
                "Plain reasoning",
                "Plain first line\n**Later bold line**",
                "**Incomplete",
                "**Title** trailing prose",
                "",
            }
        )
            Assert.Null(SessionLiveActivity.ReasoningTitle(text));
        var title = SessionLiveActivity.ReasoningTitle("**" + new string('x', 400) + "**\n");
        Assert.True(title!.Length <= 200);
    }

    [Fact]
    public void A_ctl_summary_is_the_activity_unless_the_tool_it_runs_states_its_own()
    {
        JsonObject Ctl(string command, JsonObject? args, string? summary)
        {
            var call = new JsonObject { ["command"] = command };
            if (args is not null)
                call["values"] = new JsonObject { ["args"] = args.DeepClone() };
            if (summary is not null)
                call["summary"] = summary;
            return call;
        }
        var mcp = new JsonObject { ["repo"] = "octo-org/demo", ["state"] = "open" };
        Assert.Equal(
            "List open issues",
            ToolActivity.CaptionSummary("ctl", Ctl("tool call mcp:github/list_issues --args @args", mcp, " List open\nissues "))
        );
        Assert.Equal("Show the timers", ToolActivity.CaptionSummary("ctl", Ctl("timer list", null, "Show the timers")));
        // Help and unparsable commands still state their purpose.
        Assert.Equal("Look up flags", ToolActivity.CaptionSummary("ctl", Ctl("node --help", null, "Look up flags")));
        Assert.Null(ToolActivity.CaptionSummary("ctl", Ctl("tool call mcp:github/list_issues --args @args", mcp, null)));
        Assert.Null(ToolActivity.CaptionSummary("ctl", Ctl("timer list", null, "  ")));
        Assert.Null(ToolActivity.CaptionSummary("exec", new JsonObject { ["command"] = "true" }));

        // Only one summary is shown: that of the exec the command runs, as a direct exec shows it.
        var exec = new JsonObject { ["command"] = "make", ["summary"] = "Build the project" };
        Assert.Equal(
            "Build the project",
            ToolActivity.CaptionSummary("ctl", Ctl("tool call node:worker/exec --args @args", exec, "Run make on the worker"))
        );
        Assert.Equal(
            "Run make on the worker",
            ToolActivity.CaptionSummary(
                "ctl",
                Ctl("tool call node:worker/exec --args @args", new JsonObject { ["command"] = "make" }, "Run make on the worker")
            )
        );
        // An MCP tool's own summary argument isn't a stated summary; the ctl one is shown.
        Assert.Equal(
            "Ask the server",
            ToolActivity.CaptionSummary(
                "ctl",
                Ctl("tool call mcp:server/exec --args @args", new JsonObject { ["summary"] = "MCP text" }, "Ask the server")
            )
        );
    }

    [Fact]
    public void Summaries_come_from_exec_and_run_script_directly_or_through_ctl_and_call_tool_but_not_mcp()
    {
        JsonObject Summary(string summary) => new() { ["summary"] = summary, ["command"] = "true" };
        Assert.Equal("Check\nlayout".Replace('\n', ' '), ToolActivity.CaptionSummary("exec", Summary("Check\nlayout")));
        Assert.Equal("Run it", ToolActivity.CaptionSummary("run_script", Summary("  Run it ")));
        foreach (
            var args in new JsonObject[]
            {
                new() { ["command"] = "true" },
                new() { ["summary"] = "   " },
                new() { ["summary"] = 123 },
                new() { ["command"] = new JsonObject { ["summary"] = "wrong" } },
            }
        )
            Assert.Null(ToolActivity.CaptionSummary("exec", args));
        foreach (var name in new[] { "read", "mcp:server/exec", "server.exec", "functions.exec", "execute" })
            Assert.Null(ToolActivity.CaptionSummary(name, Summary("Do not show")));

        JsonObject Ctl(string target) =>
            new()
            {
                ["command"] = $"tool call {target} --args @args",
                ["values"] = new JsonObject { ["args"] = Summary("Routed " + target) },
            };
        Assert.Equal(
            "Routed node:worker/exec",
            ToolActivity.CaptionSummary("ctl", Ctl("node:worker/exec"))
        );
        Assert.Equal(
            "Routed builtin:run_script",
            ToolActivity.CaptionSummary("ctl", Ctl("builtin:run_script"))
        );
        foreach (var target in new[] { "mcp:server/exec", "mcp:server/run_script", "builtin:read" })
            Assert.Null(ToolActivity.CaptionSummary("ctl", Ctl(target)));
        Assert.Null(
            ToolActivity.CaptionSummary("ctl", new JsonObject { ["command"] = "tool call node:x/exec --args @args" })
        );
        Assert.Null(ToolActivity.CaptionSummary("ctl", new JsonObject { ["command"] = "session list" }));
        // Tool help names the target but does not run it.
        var help = Ctl("node:worker/exec");
        help["command"] = "tool call node:worker/exec --help";
        help.Remove("values");
        Assert.Null(ToolActivity.CaptionSummary("ctl", help));

        foreach (
            var route in new JsonObject[]
            {
                new() { ["toolId"] = "node:provider/worker/exec" },
                new() { ["source"] = "node", ["name"] = "exec" },
                new() { ["toolId"] = "builtin:run_script" },
                new() { ["source"] = "builtin", ["name"] = "run_script" },
            }
        )
        {
            var nested = (JsonObject)route.DeepClone();
            nested["args"] = Summary("Nested");
            Assert.Equal("Nested", ToolActivity.CaptionSummary("call_tool", nested));
            var encoded = (JsonObject)route.DeepClone();
            encoded["argsJson"] = Summary("Encoded").ToJsonString();
            Assert.Equal("Encoded", ToolActivity.CaptionSummary("call_tool", encoded));
        }
        foreach (
            var route in new JsonObject[]
            {
                new() { ["toolId"] = "mcp:server/exec" },
                new() { ["source"] = "mcp", ["name"] = "run_script", ["server"] = "s" },
                new() { ["name"] = "exec" },
                new() { ["toolId"] = "builtin:read" },
                new() { ["toolId"] = "mcp:server/exec", ["source"] = "node", ["name"] = "exec" },
            }
        )
        {
            route["args"] = Summary("Do not show");
            Assert.Null(ToolActivity.CaptionSummary("call_tool", route));
        }
    }

    [Fact]
    public void Streaming_arguments_yield_a_summary_only_once_its_string_is_complete()
    {
        var summary = "Inspect \"quoted\" paths, \\slashes,\nUnicode 雪 🦊";
        var encoded = JsonValue.Create(summary)!.ToJsonString();
        string? Caption(string name, string raw) =>
            SessionLiveActivity.PartialObject(raw) is { } args
                ? ToolActivity.CaptionSummary(name, args)
                : null;
        var expected = ToolActivity.SingleLine(summary);
        foreach (var name in new[] { "exec", "run_script" })
        {
            for (var end = 0; end < encoded.Length; end++)
                Assert.Null(Caption(name, "{\"summary\":" + encoded[..end]));
            Assert.Equal(expected, Caption(name, "{\"summary\":" + encoded));
            Assert.Equal(expected, Caption(name, "{\"summary\":" + encoded + ",\"command\":\"unfinished"));
            Assert.Equal("Unicode 雪", Caption(name, "{\"summary\":\"Unicode \\u96ea\""));
            Assert.Equal(
                "right",
                Caption(name, "{\"command\":\"echo {\\\"summary\\\":\\\"wrong\\\"}\",\"summary\":\"right\"")
            );
            foreach (
                var raw in new[]
                {
                    "{\"command\":\"summary: wrong",
                    "{\"command\":{\"summary\":\"wrong\"}",
                    "{\"other\":[{\"summary\":\"wrong\"}]",
                    "{\"summary\":\"   \"}",
                    "{\"summary\":123}",
                    "not json",
                    "",
                }
            )
                Assert.Null(Caption(name, raw));
        }
        Assert.Equal(
            expected,
            Caption("call_tool", "{\"toolId\":\"node:worker/exec\",\"args\":{\"summary\":" + encoded + ",\"command\":\"unfin")
        );
        var ctl =
            "{\"command\":\"tool call node:worker/exec --args @args\",\"values\":{\"args\":{\"summary\":"
            + encoded;
        Assert.Null(Caption("ctl", ctl[..^1]));
        Assert.Equal(expected, Caption("ctl", ctl + ",\"command\":\"make"));
        var partial = SessionLiveActivity.PartialObject("{\"a\":[1,{\"b\":true},\"c\"],\"n\":12,\"m\":1")!;
        Assert.Equal("[1,{\"b\":true},\"c\"]", partial["a"]!.ToJsonString());
        Assert.Equal(12, partial["n"]!.GetValue<int>());
        Assert.False(partial.ContainsKey("m"));
    }
}
