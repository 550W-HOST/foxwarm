using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Inbound MCP `ctl` is the ctl grammar over the existing wrappers, used by the official C# SDK
// over real HTTP: the same results, external default-deny policy and activity records.
public sealed class InboundMcpCtlTests
{
    private static Task<JsonObject> Ctl(
        ModelContextProtocol.Client.McpClient client,
        string command,
        JsonObject? values = null
    ) =>
        InboundMcpFixture.CallAsync(
            client,
            "ctl",
            values is null
                ? new JsonObject { ["command"] = command }
                : new JsonObject { ["command"] = command, ["values"] = values }
        );

    private static string Text(JsonObject result) =>
        result["content"]![0]!["text"]!.GetValue<string>();

    private static bool Failed(JsonObject result) => result["isError"]?.GetValue<bool>() == true;

    [Fact]
    public async Task Ctl_runs_external_commands_through_the_wrappers_under_external_policy()
    {
        await using var f = await InboundMcpFixture.CreateAsync(allow: false);
        await f.PolicyAsync(
            "version: 1\nrules:\n  - id: selected-read\n    action: allow\n    match:\n      externalId: alpha\n      tool: {source: builtin, name: view_session}\n      args: {sessionId: "
                + f.Target.Id
                + "}\n"
        );
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            Enumerable.Range(1, 3).Select(n => VectorFixture.Message("line-" + n, "user")).ToArray()
        );
        await using var client = await f.ClientAsync();

        var tools = await client.ListToolsAsync();
        Assert.Equal(InboundMcpFixture.ToolNames, tools.Select(tool => tool.Name).ToArray());

        // Help lists external commands the policy may allow; denied capabilities and model-only
        // commands are absent.
        var help = await Ctl(client, "help");
        Assert.False(Failed(help), help.ToJsonString());
        Assert.Contains("session", Text(help));
        Assert.Contains("exec", Text(help));
        Assert.DoesNotContain("memory", Text(help));
        Assert.DoesNotContain("timer", Text(help));
        var sessionHelp = Text(await Ctl(client, "session --help"));
        Assert.Contains("session view", sessionHelp);
        Assert.DoesNotContain("session list", sessionHelp);
        Assert.DoesNotContain("session send", sessionHelp);
        Assert.DoesNotContain("ctl ", Text(await Ctl(client, "session view --help")));

        // The same read as the wrapper, through the same owner.
        var wrapper = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject { ["action"] = "read", ["sessionId"] = f.Target.Id, ["count"] = 2 }
        );
        var read = await Ctl(client, "session view @id --count 2", new JsonObject { ["id"] = f.Target.Id });
        Assert.False(Failed(read), read.ToJsonString());
        Assert.Equal(wrapper["structuredContent"]!.ToJsonString(), read["structuredContent"]!.ToJsonString());

        // Policy denial is the wrapper's own result.
        var deniedWrapper = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject { ["action"] = "list" }
        );
        var denied = await Ctl(client, "session list");
        Assert.True(Failed(denied));
        Assert.Equal(Text(deniedWrapper), Text(denied));
        Assert.True(Failed(await Ctl(client, "session send " + f.Target.Id + " hello")));

        // Parse errors show the external usage; model commands and parameters do not exist here.
        var missing = await Ctl(client, "session view");
        Assert.True(Failed(missing));
        Assert.Contains("Usage: session view <session-id>", Text(missing));
        Assert.Contains("Unknown command `memory read`.", Text(await Ctl(client, "memory read MEMORY.md")));
        Assert.Contains("Unknown command `node copy`", Text(await Ctl(client, "node copy a b c d")));
        // session list is denied here: any error of it reports the command as unavailable.
        Assert.StartsWith(
            "`session list` is not available to this connection.",
            Text(await Ctl(client, "session list --query x"))
        );
        Assert.Equal(
            "Unknown option `--query`.",
            Assert.IsType<CtlError>(
                CtlParser.Parse(new JsonObject { ["command"] = "session list --query x" }, "external")
            ).Message
        );
        Assert.True(
            Failed(
                await InboundMcpFixture.CallAsync(
                    client,
                    "ctl",
                    new JsonObject { ["command"] = "help", ["valuesJson"] = "{}" }
                )
            )
        );
        Assert.True(Failed(await Ctl(client, "help @x", new JsonObject { ["x"] = 1 })));
    }

    [Fact]
    public async Task Ctl_sends_lists_and_calls_pairing_tools_with_activity_records()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var client = await f.ClientAsync();

        var list = await Ctl(client, "session list --count 1");
        Assert.False(Failed(list), list.ToJsonString());
        Assert.Equal(
            (
                await InboundMcpFixture.CallAsync(
                    client,
                    "foxwarm_session",
                    new JsonObject { ["action"] = "list", ["count"] = 1 }
                )
            )["structuredContent"]!.ToJsonString(),
            list["structuredContent"]!.ToJsonString()
        );
        Assert.Contains("1–50", Text(await Ctl(client, "session list --help")));
        Assert.Contains("this connection only", Text(await Ctl(client, "node select --help")));

        // External send keeps its rest text unchanged, including newlines and quotes.
        var message = "first line\n  second 'quoted' line";
        var sent = await Ctl(client, "session send " + f.Target.Id + " " + message);
        Assert.False(Failed(sent), sent.ToJsonString());
        var item = Assert.Single(f.Target.Entry.Snapshot().Queue);
        Assert.Equal(message, item.Parts![1]["text"]!.GetValue<string>());
        Assert.Contains("external-input", item.Parts[0]["system"]!.GetValue<string>());

        var nodes = await Ctl(client, "node list");
        Assert.False(Failed(nodes), nodes.ToJsonString());
        Assert.Equal(
            Text(await InboundMcpFixture.CallAsync(client, "foxwarm_node", new JsonObject { ["action"] = "list" })),
            Text(nodes)
        );
        Assert.False(Failed(await Ctl(client, "node status")));

        var pending = await Ctl(client, "node pending");
        Assert.False(Failed(pending), pending.ToJsonString());
        var viaTool = await Ctl(client, "tool call builtin:node_pair_list");
        Assert.Equal(Text(pending), Text(viaTool));
        Assert.True(Failed(await Ctl(client, "node approve missing-request")));

        var search = await Ctl(client, "tool search pair --source builtin --limit 5");
        Assert.False(Failed(search), search.ToJsonString());
        Assert.Contains(
            "builtin:node_pair_list",
            search["structuredContent"]!["tools"]!.AsArray().Select(tool => tool!["toolId"]!.GetValue<string>())
        );
        // Builtins appear as their external commands; the structured rows keep the tool ID.
        Assert.Contains("node pending — ", Text(search));
        Assert.DoesNotContain("builtin:", Text(search));
        Assert.DoesNotContain("tool call", Text(search));
        var pendingRow = search["structuredContent"]!["tools"]!.AsArray().Single(tool => tool!["command"]?.GetValue<string>() == "node pending")!;
        Assert.Equal("command", pendingRow["kind"]!.GetValue<string>());
        Assert.False(pendingRow.AsObject().ContainsKey("inputSchema"));
        var helped = Text(await Ctl(client, "tool call builtin:node_pair_list --help"));
        Assert.Contains("node pending — ", helped);
        Assert.DoesNotContain("builtin:", helped);
        Assert.Contains("Invalid tool ID", Text(await Ctl(client, "tool call builtin:session")));
        Assert.Contains("--node-id", Text(await Ctl(client, "tool call --source node --name read")));
        Assert.True(Failed(await Ctl(client, "exec result missing")));
        Assert.Equal(
            Text(
                await InboundMcpFixture.CallAsync(
                    client,
                    "foxwarm_exec_result",
                    new JsonObject { ["execId"] = "missing" }
                )
            ),
            Text(await Ctl(client, "exec result missing"))
        );

        // ctl tool calls are recorded like foxwarm_call: external-mcp rows for the client.
        JsonObject[] rows = [];
        for (var attempt = 0; attempt < 100; attempt++)
        {
            rows = ActivityIndexTests
                .Items(f.Manager.Activity.Query(new ActivityQuery(Kind: "all")))
                .Where(row => SessionWait.Text(row["tool"]) is "node_pair_list" or "node_pair_approve")
                .ToArray();
            if (rows.Length >= 3)
                break;
            await Task.Delay(50);
        }
        Assert.Equal(3, rows.Length);
        Assert.Single(rows, row => SessionWait.Text(row["outcome"]) != "ok");
    }

    // External `tool search` follows the model's rules: whole-word matches, tool IDs with a
    // summary, schemas only with --schema, and `tool call <tool-id> --help` for arguments. The
    // foxwarm_discover wrapper keeps its tool-ID list and default schemas.
    [Fact]
    public async Task Ctl_tool_search_shows_ids_and_summaries_and_tool_help()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var client = await f.ClientAsync();

        var search = await Ctl(client, "tool search probe --source mcp");
        Assert.False(Failed(search), search.ToJsonString());
        Assert.Contains("\nmcp:peer/probe — Synthetic outbound qualification\n", Text(search));
        Assert.Contains("`tool call <tool-id> --help`", Text(search));
        Assert.DoesNotContain("args:", Text(search));
        var row = search["structuredContent"]!["tools"]![0]!.AsObject();
        Assert.Equal("mcp:peer/probe", row["toolId"]!.GetValue<string>());
        Assert.Equal("tool", row["kind"]!.GetValue<string>());
        Assert.False(row.ContainsKey("inputSchema"));
        var schema = await Ctl(client, "tool search probe --source mcp --schema");
        Assert.Contains("    args: ", Text(schema));
        Assert.True(schema["structuredContent"]!["tools"]![0]!.AsObject().ContainsKey("inputSchema"));
        // Whole words only.
        Assert.StartsWith("No matching", Text(await Ctl(client, "tool search prob --source mcp")));

        var wrapper = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_discover",
            new JsonObject { ["query"] = "probe", ["sources"] = new JsonArray("mcp") }
        );
        Assert.Contains("- \"mcp:peer/probe\"", Text(wrapper));
        Assert.True(wrapper["structuredContent"]!["tools"]![0]!.AsObject().ContainsKey("inputSchema"));

        var help = await Ctl(client, "tool call mcp:peer/probe --help");
        Assert.False(Failed(help), help.ToJsonString());
        Assert.StartsWith("Tool: mcp:peer/probe\n", Text(help));
        Assert.Contains("Synthetic outbound qualification", Text(help));
        Assert.Equal("mcp:peer/probe", help["structuredContent"]!["tool"]!["toolId"]!.GetValue<string>());
        Assert.True(Failed(await Ctl(client, "tool call mcp:peer/missing --help")));
        Assert.True(Failed(await Ctl(client, "tool call --source mcp --name probe --help")));
        Assert.DoesNotContain(await peer.EventsAsync(), item => item["kind"]?.ToString() == "call");
    }
}
