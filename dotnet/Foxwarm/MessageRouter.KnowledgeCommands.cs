using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleSkillCommandAsync(
        ExternalChannelContext source,
        string[] args,
        string agent
    )
    {
        var skills = runtime.Manager.SkillCatalog;
        switch (args.FirstOrDefault())
        {
            case null:
                await source.Reply(
                    "🧩 *Skill Commands*\n\n`/skill list` - List available skills\n`/skill show <skill>` - Show skill documents\n"
                );
                return;
            case "list":
                var list = await skills.ListAsync(agent);
                await source.Reply(
                    list.Count == 0
                        ? $"No skills found for agent `{agent}`."
                        : $"🧩 *Skills for {agent}* ({list.Count})\n\n"
                            + string.Join(
                                "\n",
                                list.Select(skill =>
                                    $"`{skill.Name}` [{skill.SourceLabel}]"
                                    + (
                                        string.IsNullOrEmpty(skill.Description)
                                            ? ""
                                            : " - " + skill.Description
                                    )
                                    + " (1 file)"
                                )
                            )
                );
                return;
            case "attach" or "detach":
                await source.Reply(
                    "❌ Skill attach/detach is no longer supported. Visible skills are cataloged automatically in session snapshots; use `/skill show <skill>` or `ctl skill load <skill>` to load full instructions on demand."
                );
                return;
            case "show":
                if (args.Length < 2)
                {
                    await source.Reply("Usage: /skill show <skill>");
                    return;
                }
                var (info, content) = await skills.LoadAsync(args[1], agent);
                var reply =
                    $"🧩 *Skill:* `{info.Name}`"
                    + (string.IsNullOrEmpty(info.Description) ? "" : "\n" + info.Description)
                    + $"\nSource: `{info.SourceLabel}`\nMetadata: `{info.MetadataPath}`\nSkill directory: `{info.Directory}`\nRelative paths in this skill are relative to the skill directory.";
                if (info.Resources.Length > 0)
                    reply +=
                        "\n\nResources (supporting files, not eagerly loaded):\n"
                        + string.Join("\n", info.Resources.Select(file => "- `" + file + "`"))
                        + (info.ResourcesTruncated ? "\n- ... (resource listing truncated)" : "");
                await source.Reply(reply + $"\n\nFILE: `{info.MetadataPath}`\n\n{content}");
                return;
            default:
                await source.Reply(
                    $"❌ Unknown subcommand: {args[0]}\nUse `/skill` to see available commands."
                );
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
            await source.Reply(
                "🤖 *Agent Commands*\n\n"
                    + string.Join(
                        "\n",
                        tree.OfType<JsonObject>()
                            .Select(row =>
                                $"`{SessionWait.Text(row["usage"]) ?? "/agent " + row["value"]}` - {row["description"]}"
                            )
                    )
            );
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
                    var ruleCount = (metadata[agent]?["rules"] as JsonArray)?.Count ?? 0;
                    output +=
                        $"`{agent}`"
                        + (count > 0 ? $" - {count} session{(count > 1 ? "s" : "")}" : "")
                        + (inherit is null ? "" : $" - inherits `{inherit}`")
                        + (ruleCount > 0 ? $" - {ruleCount} rule(s)" : "")
                        + "\n";
                }
                await source.Reply(names.Length == 0 ? "No agents found." : output);
                return;
            case "create":
                if (args.Length < 2)
                {
                    await source.Reply(
                        "Usage: /agent create <name> [--no-main]"
                    );
                    return;
                }
                var name = args[1];
                var createMain = !args.Contains("--no-main");
                AgentCatalog.ValidateName(name);
                var soul =
                    $"# SOUL.md - Who You Are\n\n*You are {name}, an AI assistant.*\n\n## Core Identity\n- Helpful and precise\n- Focus on your assigned tasks\n\n## Working Style\n- Think before acting\n- Collaborate using send_to_session when needed\n";
                var created = await manager.CreateAgentAsync(
                    name,
                    createMain,
                    initialSoul: soul
                );
                await source.Reply(
                    $"✅ Agent \"{name}\" created successfully!\n\nAgent folder: `agents/{name}`"
                        + (
                            createMain
                                ? $"\nMain session: `{created.MainSessionId}`"
                                : "\nMain session: not created (`--no-main`)"
                        )
                );
                return;
            case "delete":
                if (args.Length < 2)
                {
                    await source.Reply(
                        "Usage: /agent delete <name> [--confirm]\nExample: /agent delete my-assistant --confirm\n\nThis deletes the Agent folder and Sessions whose IDs start with `<name>/`. Archived history is retained."
                    );
                    return;
                }
                var deleteName = args[1];
                AgentCatalog.ValidateName(deleteName);
                if (!args.Skip(2).Contains("--confirm"))
                {
                    await source.Reply(
                        $"Delete Agent \"{deleteName}\"?\n\nThis will:\n- Delete Sessions whose IDs start with `{deleteName}/`\n- Delete the Agent folder and memory\n- Keep archived history\n\nThis cannot be undone automatically.\nTo confirm, run:\n`/agent delete {deleteName} --confirm`"
                    );
                    return;
                }
                try
                {
                    var deleted = await manager.DeleteAgentFromCommandAsync(deleteName);
                    await source.Reply(
                        $"✅ Agent \"{deleteName}\" deleted successfully.\n\nDeleted {deleted.Length} session(s)."
                    );
                }
                catch (Exception error)
                {
                    await source.Reply(
                        error.Message == $"Agent \"{deleteName}\" not found."
                            ? $"❌ Agent \"{deleteName}\" not found."
                            : "❌ Failed to delete agent: " + error.Message
                    );
                }
                return;
            case "inherit":
                if (args.Length < 3)
                {
                    await source.Reply("Usage: /agent inherit <agent> <parent-agent|none>");
                    return;
                }
                var parent = args[2] == "none" ? null : args[2];
                await manager.SetAgentInheritAsync(args[1], parent);
                await source.Reply(
                    (
                        parent is null
                            ? $"✅ Cleared shared memory inheritance for agent \"{args[1]}\"."
                            : $"✅ Agent \"{args[1]}\" now inherits shared memory from `{parent}`."
                    )
                        + "\nInheritance chain: "
                        + string.Join(
                            " -> ",
                            manager.AgentChain(args[1]).Select(agent => "`" + agent + "`")
                        )
                );
                return;
            default:
                await source.Reply(
                    $"❌ Unknown subcommand: {sub}\nUse `/agent` to see available commands."
                );
                return;
        }
    }
}
