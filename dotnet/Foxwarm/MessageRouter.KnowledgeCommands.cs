using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleSkillCommandAsync(ExternalChannelContext source, string[] args, string agent)
    {
        var skills = runtime.Manager.SkillCatalog;
        switch (args.FirstOrDefault())
        {
            case null:
                await source.Reply("🧩 *Skill Commands*\n\n`/skill list` - List available skills\n`/skill show <skill>` - Show skill documents\n");
                return;
            case "list":
                var list = await skills.ListAsync(agent);
                await source.Reply(list.Count == 0 ? $"No skills found for agent `{agent}`."
                    : $"🧩 *Skills for {agent}* ({list.Count})\n\n" + string.Join("\n", list.Select(skill =>
                        $"`{skill.Name}` [{skill.SourceLabel}]" + (string.IsNullOrEmpty(skill.Description) ? "" : " - " + skill.Description) + " (1 file)")));
                return;
            case "attach" or "detach":
                await source.Reply("❌ Skill attach/detach is no longer supported. Visible skills are cataloged automatically in session snapshots; use `/skill show <skill>` or `skill({ action: \"load\", skillName: \"<skill>\" })` to load full instructions on demand.");
                return;
            case "show":
                if (args.Length < 2) { await source.Reply("Usage: /skill show <skill>"); return; }
                var (info, content) = await skills.LoadAsync(args[1], agent);
                var reply = $"🧩 *Skill:* `{info.Name}`" + (string.IsNullOrEmpty(info.Description) ? "" : "\n" + info.Description)
                    + $"\nSource: `{info.SourceLabel}`\nMetadata: `{info.MetadataPath}`\nSkill directory: `{info.Directory}`\nRelative paths in this skill are relative to the skill directory.";
                if (info.Resources.Length > 0)
                    reply += "\n\nResources (supporting files, not eagerly loaded):\n" + string.Join("\n", info.Resources.Select(file => "- `" + file + "`"))
                        + (info.ResourcesTruncated ? "\n- ... (resource listing truncated)" : "");
                await source.Reply(reply + $"\n\nFILE: `{info.MetadataPath}`\n\n{content}");
                return;
            default:
                await source.Reply($"❌ Unknown subcommand: {args[0]}\nUse `/skill` to see available commands.");
                return;
        }
    }

    private async Task HandleAgentCommandAsync(ExternalChannelContext source, string[] args)
    {
        var manager = runtime.Manager;
        var sub = args.FirstOrDefault();
        if (sub is null)
        {
            var tree = ExternalCommands.Find("/agent")!["autocomplete"]!["children"]!.AsArray();
            await source.Reply("🤖 *Agent Commands*\n\n" + string.Join("\n", tree.OfType<JsonObject>().Select(row =>
                $"`{SessionWait.Text(row["usage"]) ?? "/agent " + row["value"]}` - {row["description"]}")));
            return;
        }
        switch (sub)
        {
            case "list":
                var names = manager.Agents();
                var rows = manager.Catalog.List();
                var metadata = manager.AgentMetadata;
                var output = $"🤖 *Agents* ({names.Length})\n\n";
                foreach (var agent in names)
                {
                    var count = rows.Count(row => SessionWait.Text(row["agent"]) == agent);
                    var inherit = SessionWait.Text(metadata[agent]?["inherit"]);
                    var isolation = manager.Isolation(agent);
                    output += $"`{agent}`" + (count > 0 ? $" - {count} session{(count > 1 ? "s" : "")}" : "")
                        + (inherit is null ? "" : $" - inherits `{inherit}`")
                        + (isolation.Isolated ? " - isolated" + (isolation.RecordedNode is { } node ? $" on `{node}`" : "") : "")
                        + $" - {isolation.Rules.Count} tool rule(s)\n";
                }
                await source.Reply(names.Length == 0 ? "No agents found." : output);
                return;
            case "create":
                if (args.Length < 2) { await source.Reply("Usage: /agent create <name> [--no-main] [--isolated <node-id>]"); return; }
                var name = args[1];
                var createMain = !args.Contains("--no-main");
                var isolatedIndex = Array.IndexOf(args, "--isolated");
                var nodeId = isolatedIndex >= 0 ? args.ElementAtOrDefault(isolatedIndex + 1) : null;
                AgentCatalog.ValidateName(name);
                var soul = $"# SOUL.md - Who You Are\n\n*You are {name}, an AI assistant.*\n\n## Core Identity\n- Helpful and precise\n- Focus on your assigned tasks\n\n## Working Style\n- Think before acting\n- Collaborate using send_to_session when needed\n";
                var created = await manager.CreateAgentAsync(name, createMain, isolatedNode: nodeId, initialSoul: soul);
                await source.Reply($"✅ Agent \"{name}\" created successfully!\n\nAgent folder: `agents/{name}`"
                    + (createMain ? $"\nMain session: `{created.MainSessionId}`" : "\nMain session: not created (`--no-main`)")
                    + (nodeId is null ? "" : $"\nIsolation: enabled on `{nodeId}`"));
                return;
            case "isolated":
                if (args.Length < 3) { await source.Reply("Usage: /agent isolated <agent> <node-id|off>"); return; }
                var before = manager.Catalog.List().Count(row => SessionWait.Text(row["agent"]) == args[1]);
                await manager.SetAgentNodeAsync(args[1], args[2] == "off" ? null : args[2]);
                await source.Reply((args[2] == "off" ? $"✅ Agent \"{args[1]}\" isolation cleared." : $"✅ Agent \"{args[1]}\" is now isolated on node `{args[2]}`.")
                    + (before > 0 ? $"\nUpdated {before} session(s)." : ""));
                return;
            case "inherit":
                if (args.Length < 3) { await source.Reply("Usage: /agent inherit <agent> <parent-agent|none>"); return; }
                var parent = args[2] == "none" ? null : args[2];
                if (parent is not null && manager.AgentIsolated(parent))
                    throw new InvalidDataException($"Agent \"{parent}\" is isolated and cannot be used as an inherit source.");
                await manager.SetAgentInheritAsync(args[1], parent);
                await source.Reply((parent is null ? $"✅ Cleared shared memory inheritance for agent \"{args[1]}\"." : $"✅ Agent \"{args[1]}\" now inherits shared memory from `{parent}`.")
                    + "\nInheritance chain: " + string.Join(" -> ", manager.AgentChain(args[1]).Select(agent => "`" + agent + "`")));
                return;
            default:
                await source.Reply($"❌ Unknown subcommand: {sub}\nUse `/agent` to see available commands.");
                return;
        }
    }
}
