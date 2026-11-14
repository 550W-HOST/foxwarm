using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm;

// `/history`, `/agent`, `/skill`, `/timer` and `/node` commands.
internal sealed partial class MessageRouter
{
    private async Task HistorySearchAsync(UserCommand command)
    {
        var owner = await command.CurrentRequiredAsync();
        var request = new JsonObject
        {
            ["vector_query"] = command.Text("query")!.Trim(),
            ["limit"] = command.Call.Number("limit") is > 0 and var limit ? (int)limit : 5,
        };
        if (command.Text("sessionId") is { } sessionId)
            request["sessionId"] = sessionId;
        if (command.Text("agentName") is { } agentName)
            request["agentName"] = agentName;
        var result = await ArchiveRecallTool.ExecuteAsync(runtime.Manager, owner, request);
        await command.Reply(
            SessionWait.Text(result["output"])
                ?? "❌ Search failed: "
                    + (SessionWait.Text(result["error"]?["message"]) ?? "Search unavailable.")
        );
    }

    private async Task AgentListAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var names = manager.Agents();
        var rows = manager.Catalog.List();
        var metadata = manager.AgentMetadata;
        var output = $"🤖 *Agents* ({names.Length})\n\n";
        foreach (var agent in names)
        {
            var count = rows.Count(row => SessionWait.Text(row["agent"]) == agent);
            var inherit = SessionWait.Text(metadata[agent]?["inherit"]);
            var ruleCount = (metadata[agent]?["rules"] as JsonArray)?.Count ?? 0;
            output +=
                $"`{agent}`"
                + (count > 0 ? $" - {count} session{(count > 1 ? "s" : "")}" : "")
                + (inherit is null ? "" : $" - inherits `{inherit}`")
                + (ruleCount > 0 ? $" - {ruleCount} rule(s)" : "")
                + "\n";
        }
        await command.Reply(names.Length == 0 ? "No agents found." : output);
    }

    private async Task AgentCreateAsync(UserCommand command)
    {
        var name = command.Text("agentName")!;
        var createMain = !command.Has("createMainSession") || command.Flag("createMainSession");
        try
        {
            AgentCatalog.ValidateName(name);
            var soul =
                $"# SOUL.md - Who You Are\n\n*You are {name}, an AI assistant.*\n\n## Core Identity\n- Helpful and precise\n- Focus on your assigned tasks\n\n## Working Style\n- Think before acting\n- Collaborate using send_to_session when needed\n";
            var created = await runtime.Manager.CreateAgentAsync(name, createMain, initialSoul: soul);
            await command.Reply(
                $"✅ Agent \"{name}\" created successfully!\n\nAgent folder: `agents/{name}`"
                    + (
                        createMain
                            ? $"\nMain session: `{created.MainSessionId}`"
                            : "\nMain session: not created (`--no-create-main-session`)"
                    )
            );
        }
        catch (Exception error)
        {
            throw new UserCommandException("❌ Failed to create agent: " + error.Message);
        }
    }

    private async Task AgentInheritAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var agent = command.Text("agentName")!;
        var parent = command.Text("inheritAgentName") is { Length: > 0 } named ? named : null;
        try
        {
            await manager.SetAgentInheritAsync(agent, parent);
        }
        catch (Exception error)
        {
            throw new UserCommandException("❌ Failed to update inherit: " + error.Message);
        }
        await command.Reply(
            (
                parent is null
                    ? $"✅ Cleared shared memory inheritance for agent \"{agent}\"."
                    : $"✅ Agent \"{agent}\" now inherits shared memory from `{parent}`."
            )
                + "\nInheritance chain: "
                + string.Join(" -> ", manager.AgentChain(agent).Select(name => "`" + name + "`"))
        );
    }

    private async Task AgentDeleteAsync(UserCommand command)
    {
        var name = command.Text("agentName")!;
        AgentCatalog.ValidateName(name);
        if (!command.Flag("confirm"))
        {
            await command.Reply(
                $"Delete Agent \"{name}\"?\n\nThis will:\n- Delete Sessions whose IDs start with `{name}/`\n- Delete the Agent folder and memory\n- Keep archived history\n\nThis cannot be undone automatically.\nTo confirm, run:\n`/agent delete {name} --confirm`"
            );
            return;
        }
        try
        {
            var deleted = await runtime.Manager.DeleteAgentFromCommandAsync(name);
            await command.Reply(
                $"✅ Agent \"{name}\" deleted successfully.\n\nDeleted {deleted.Length} session(s)."
            );
        }
        catch (Exception error)
        {
            throw new UserCommandException(
                error.Message == $"Agent \"{name}\" not found."
                    ? $"❌ Agent \"{name}\" not found."
                    : "❌ Failed to delete agent: " + error.Message
            );
        }
    }

    private async Task<string> SkillAgentAsync(UserCommand command) =>
        command.Text("agentName") ?? (await command.CurrentAsync())?.Agent ?? "main";

    private async Task SkillListAsync(UserCommand command)
    {
        var agent = await SkillAgentAsync(command);
        var list = await runtime.Manager.SkillCatalog.ListAsync(agent);
        await command.Reply(
            list.Count == 0
                ? $"No skills found for agent `{agent}`."
                : $"🧩 *Skills for {agent}* ({list.Count})\n\n"
                    + string.Join(
                        "\n",
                        list.Select(skill =>
                            $"`{skill.Name}` [{skill.SourceLabel}]"
                            + (string.IsNullOrEmpty(skill.Description) ? "" : " - " + skill.Description)
                        )
                    )
        );
    }

    private async Task SkillLoadAsync(UserCommand command)
    {
        var agent = await SkillAgentAsync(command);
        try
        {
            var (info, content) = await runtime.Manager.SkillCatalog.LoadAsync(
                command.Text("skillName")!,
                agent
            );
            var reply =
                $"🧩 *Skill:* `{info.Name}`"
                + (string.IsNullOrEmpty(info.Description) ? "" : "\n" + info.Description)
                + $"\nSource: `{info.SourceLabel}`\nMetadata: `{info.MetadataPath}`\nSkill directory: `{info.Directory}`\nRelative paths in this skill are relative to the skill directory.";
            if (info.Resources.Length > 0)
                reply +=
                    "\n\nResources (supporting files, not eagerly loaded):\n"
                    + string.Join("\n", info.Resources.Select(file => "- `" + file + "`"))
                    + (info.ResourcesTruncated ? "\n- ... (resource listing truncated)" : "");
            await command.Reply(reply + $"\n\nFILE: `{info.MetadataPath}`\n\n{content}");
        }
        catch (Exception error)
        {
            throw new UserCommandException("❌ Skill load failed: " + error.Message);
        }
    }

    private static string TimerDate(JsonNode? value) =>
        SessionWait.Number(value) is > 0 and var stamp
            ? DateTimeOffset
                .FromUnixTimeMilliseconds((long)stamp)
                .ToString(
                    "yyyy-MM-dd\'T\'HH:mm:ss.fff\'Z\'",
                    System.Globalization.CultureInfo.InvariantCulture
                )
            : "n/a";

    private static string TimerAction(JsonObject timer) =>
        TimerArguments.Script(timer)
            ? "ToolScript ("
                + (
                    SessionWait.Text(timer["script"]?["code"]) is { Length: > 0 }
                        ? "inline"
                        : (SessionWait.Text(timer["script"]?["node"]) ?? "current")
                            + ": "
                            + SessionWait.Text(timer["script"]?["filePath"])
                )
                + ")"
            : SessionWait.Text(timer["message"]) ?? "";

    // A timer operation failure: its message and whether the change was committed anyway.
    private static string TimerFailure(JsonObject result, string prefix) =>
        "❌ "
        + prefix
        + (SessionWait.Text(result["error"]?["message"]) ?? "Timer unavailable.")
        + (
            SessionCatalog.Flag(result["timerCommitted"])
                ? $" Timer `{result["timerId"]}` change was committed."
                : ""
        );

    private async Task TimerListAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var list = runtime.Manager.Timers.List(owner.Id);
        await command.Reply(
            list.Count == 0
                ? "No timers found for this session."
                : $"⏰ *Timers for session `{owner.Id}`*\n\n"
                    + string.Join(
                        "",
                        list.OfType<JsonObject>()
                            .Select(timer =>
                                $"- `{timer["id"]}` - "
                                + (
                                    SessionWait.Text(timer["mode"]) == "cron"
                                        ? $"cron: `{timer["cron"]}`"
                                        : "at: " + TimerDate(timer["at"])
                                )
                                + (
                                    SessionCatalog.Flag(timer["paused"])
                                        ? " - paused"
                                        : " - next: " + TimerDate(timer["nextRunAt"])
                                )
                                + " - "
                                + (
                                    SessionCatalog.Flag(timer["newSession"])
                                        ? $"new session ({SessionWait.Text(timer["agentName"]) ?? "main"} / {SessionWait.Text(timer["sessionPrefix"]) ?? "timer"})"
                                        : "this session"
                                )
                                + $"\n  {TimerAction(timer)}\n"
                            )
                    )
        );
    }

    private async Task TimerDeleteAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var id = command.Text("timerId")!;
        var result = await runtime.Manager.ExecuteTimerCommandAsync(
            owner,
            "delete_timer",
            new JsonObject { ["timerId"] = id }
        );
        if (result["error"] is not null)
            throw new UserCommandException(TimerFailure(result, ""));
        await command.Reply(
            SessionCatalog.Flag(result["deleted"])
                ? $"✅ Timer `{id}` deleted."
                : $"❌ Timer `{id}` not found."
        );
    }

    private async Task TimerPauseAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var id = command.Text("timerId")!;
        var pause = command.Verb == "pause";
        var result = await runtime.Manager.ExecuteTimerCommandAsync(
            owner,
            "update_timer",
            new JsonObject { ["timerId"] = id, ["paused"] = pause }
        );
        if (result["timer"] is not JsonObject timer)
            throw new UserCommandException(TimerFailure(result, ""));
        await command.Reply(
            pause
                ? $"⏸️ Timer `{id}` paused."
                : $"▶️ Timer `{id}` resumed. Next run: {TimerDate(timer["nextRunAt"])}"
        );
    }

    private async Task TimerCreateAsync(UserCommand command)
    {
        var owner = await command.CurrentRequiredAsync();
        var request = new JsonObject();
        foreach (var name in new[] { "at", "afterSeconds", "cron", "newSession", "sessionPrefix", "agentName" })
            if (command.Call.Args[name] is { } value)
                request[name] = value.DeepClone();
        var message = command.Text("message")?.Trim();
        if (string.IsNullOrEmpty(message))
            throw new UserCommandException(
                "❌ Give the message after the schedule, for example `/timer create --after-seconds 600 Check the build`."
            );
        request["message"] = message;
        var created = await runtime.Manager.ExecuteTimerCommandAsync(owner, "create_timer", request);
        if (created["timer"] is not JsonObject timer)
            throw new UserCommandException(TimerFailure(created, "Timer creation failed: "));
        await command.Reply(
            $"✅ Timer created: `{timer["id"]}`\n"
                + (SessionWait.Text(timer["mode"]) == "cron" ? "Next run: " : "Fires at: ")
                + TimerDate(timer["nextRunAt"])
        );
    }

    private async Task NodeListAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var current = await command.CurrentAsync();
        var reply = "📋 **Nodes**\n\n";
        if (current is not null)
            reply += $"💡 Current node: `{manager.CurrentNode(current)}`\n\n";
        foreach (var node in (await manager.NodeSummariesAsync()).OfType<JsonObject>())
            reply += NodeRow(node) + "\n";
        await command.Reply(reply + "\n" + NodePairList());
    }

    private string NodePairList()
    {
        var pending = runtime.Manager.Nodes.ListPending();
        var reply = "**Pending Approvals**\n";
        if (pending.Count == 0)
            reply += "- (No pending pairing requests)\n";
        foreach (var entry in pending.OfType<JsonObject>())
        {
            var protocol = Foxwarm.Nodes.NodeConnectionHub.Protocol(
                new JsonObject { ["nodeProtocol"] = entry["nodeProtocol"]?.DeepClone() }
            );
            reply +=
                $"- `{entry["id"]}` [{entry["nodeType"]}] requested=`{SessionWait.Text(entry["requestedName"]) ?? "-"}`"
                + (SessionCatalog.Flag(entry["connected"]) ? " ✅ online" : " offline")
                + (entry["approvedNodeId"] is null ? "" : $" approved→`{entry["approvedNodeId"]}`")
                + (
                    SessionWait.Text(protocol["status"]) == "compatible"
                        ? $" protocol=v{protocol["negotiated"]}"
                        : " ⚠️ upgrade required"
                )
                + "\n";
        }
        return reply;
    }

    private async Task NodeSelectAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var selected = await runtime.Manager.SelectNodeAsync(owner, command.Text("nodeId")!);
        await command.Reply(
            $"✅ Switched to node `{selected["nodeId"]}`\n\nAll file/exec/browser tools will now execute on this node."
        );
    }

    private async Task NodeInspectAsync(UserCommand command)
    {
        var id = command.Text("nodeId")!;
        var summary =
            (await runtime.Manager.NodeSummariesAsync())
                .OfType<JsonObject>()
                .FirstOrDefault(node => SessionWait.Text(node["id"]) == id)
            ?? throw new UserCommandException($"❌ Node `{id}` not found.");
        await command.Reply(
            $"Node inspection: `{id}`\n```json\n"
                + summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true })
                + "\n```"
        );
    }

    private async Task NodeRemoveAsync(UserCommand command)
    {
        var id = command.Text("nodeId")!;
        var disconnected = runtime.Manager.Nodes.Remove(id);
        await command.Reply(
            $"✅ Removed approved node `{id}`.\nRuntime connection: `{(disconnected ? "closed" : "not online")}`.\nThe old node credentials are no longer valid; the node must be paired again before it can reconnect."
        );
    }

    private async Task NodePairApproveAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var pendingId = command.Text("pendingId")!;
        var pending = manager
            .Nodes.ListPending()
            .OfType<JsonObject>()
            .FirstOrDefault(row => SessionWait.Text(row["id"]) == pendingId);
        var approved = await manager.Nodes.ApproveAsync(pendingId, command.Text("nodeId"));
        await command.Reply(
            $"✅ Approved pending pairing `{pendingId}`\n\nNode id: `{approved["nodeId"]}`\nRequested name: `{SessionWait.Text(pending?["requestedName"]) ?? "-"}`\nDelivered live: `{(SessionCatalog.Flag(approved["deliveredLive"]) ? "yes" : "no")}`\n\nPer-node token (save securely):\n`{approved["authToken"]}`"
        );
    }

    private async Task NodePairRejectAsync(UserCommand command)
    {
        var pendingId = command.Text("pendingId")!;
        runtime.Manager.Nodes.Reject(pendingId, null);
        await command.Reply($"✅ Rejected pending pairing `{pendingId}`");
    }

    private async Task NodeTokenAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var result = manager.Nodes.Registry.Create(command.Text("nodeId")!);
        var url = SessionWait.Text(manager.Bootstrap!.Info()["baseUrl"])!;
        var quote = "'" + url.Replace("'", "'\"'\"'") + "'";
        await command.Reply(
            $"✅ Created node `{result["nodeId"]}`. Its per-node auth token is in the command below. Save it now; it will not be shown again.\n\nStart the Node directly, without a pending approval:\n```bash\nBASE_URL={quote}\ncurl -fsSL \"$BASE_URL/node/run.sh\" | bash -s -- --dir=/opt/foxwarm-node --host=\"$BASE_URL\" --node-id={result["nodeId"]} --auth-token={result["authToken"]}\n```"
        );
    }

    private string NodeBootstrapInfo()
    {
        var info = runtime.Manager.Bootstrap!.Info();
        var commands = info["commands"]!.AsObject();
        var reply = "🧩 **Node Pairing / Bootstrap Help**\n\n" + info["instruction"] + "\n\n";
        foreach (
            var (key, title, language) in new[]
            {
                ("bareMetal", "Linux CLI", "bash"),
                ("bareMetalInstall", "Linux CLI with systemd startup", "bash"),
                ("interactive", "Interactive CLI", "bash"),
                ("docker", "Docker", "bash"),
                ("manualCompose", "Manual Docker Compose", "bash"),
                ("windows", "Windows CLI (PowerShell bootstrap)", "powershell"),
            }
        )
            reply += $"**{title}**\n```{language}\n{commands[key]}\n```\n\n";
        return reply
            + "**Shell-only Node (POSIX sh + curl; exec only)**\nFirst run `/node token my-shell`; replace the per-node token placeholder below with its token.\n```sh\n"
            + commands["shell"]
            + "\n```\n\n**Shell-only Node (Windows PowerShell 5.1; exec only)**\nUse the same pre-created per-node credential with the Windows client.\n```powershell\n"
            + commands["windowsShell"]
            + "\n```\n\n**Approve a pending Node**\nCopy the exact `/node pair-approve <pending-id>` command shown by the client, or approve it in WebUI → Nodes → New nodes.\n\nThe commands above contain pairing credentials. Keep them private.";
    }

    private async Task NodeRenameAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var from = command.Text("nodeId")!;
        var to = command.Text("newNodeId")!;
        var online = manager.Nodes.Connected(from);
        manager.Nodes.Rename(from, to);
        await command.Reply(
            $"✅ Renamed approved node `{from}` → `{to}`.\nAuth token hash and metadata were preserved server-side.\nRuntime connection: `{(online ? "old connection closed" : "old node not online")}`.\nNode-side credentials still store the old node id. Update the node credentials file to use nodeId `{to}` with the existing authToken, then restart the node so it reconnects with the new id."
        );
    }

    private static string NodeRow(JsonObject node) =>
        $"- `{node["id"]}` [{node["type"]}] "
        + (
            SessionWait.Text(node["id"]) == "master" ? "ready"
            : SessionWait.Text(node["protocolCompatibility"]?["status"]) == "upgrade-required"
                ? (SessionCatalog.Flag(node["connected"]) ? "⚠️ connected" : "offline")
                    + " · upgrade required"
            : SessionCatalog.Flag(node["connected"]) ? "✅ online"
            : "offline"
        )
        + (
            SessionWait.Text(node["requestedName"]) is { } requested
            && requested != SessionWait.Text(node["id"])
                ? $" requested=`{requested}`"
                : ""
        )
        + (
            SessionWait.Number(node["lastSeenAt"]) is { } stamp
                ? " lastSeen=" + SessionStatus.Date(stamp)
                : ""
        );
}
