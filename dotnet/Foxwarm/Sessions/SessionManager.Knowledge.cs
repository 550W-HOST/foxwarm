using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal Skills SkillCatalog => skills;

    internal string? AgentInherit(string name) => agents.Inherit(name);

    internal string[] AgentChain(string name) => agents.InheritanceChain(name);

    internal async Task<object> SetAgentInheritAsync(
        string name,
        string? parent,
        bool refresh = false
    )
    {
        if (!Accepting)
            throw new InvalidOperationException("Host is shutting down.");
        parent = AgentCatalog.InheritName(parent);
        await agents.SetInheritAsync(name, parent);
        TopologyChanged?.Invoke();
        var affected = new List<string>();
        if (refresh)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var selected = MetadataRows()
                .Select(Metadata)
                .Where(row =>
                    AgentChain(row.Agent).Contains(name, StringComparer.Ordinal)
                    && Math.Max(0, now - row.LastMessageTime) <= 60 * 60 * 1000
                )
                .Select(row => row.Id)
                .ToArray();
            foreach (var id in selected)
            {
                var owner = await RequiredAsync(id);
                if (Stale(owner, now))
                    continue; // Catalog recency selects candidates; validated JSON can prove an older current state.
                await RefreshSnapshotAsync(owner);
                affected.Add(owner.Id);
            }
        }
        return new JsonObject
        {
            ["affectedSessions"] = JsonData.Node(affected.ToArray()),
            ["inheritanceChain"] = JsonData.Node(AgentChain(name)),
        };
    }

    private static bool Stale(SessionOwner owner, long now) =>
        owner.Entry.WithState(state =>
            SessionWait.Number(state.Meta["lastMessageTime"]) is double last
            && double.IsFinite(last)
            && Math.Max(0, now - last) > 60 * 60 * 1000
        );

    private async Task MaybeRefreshStaleAsync(SessionOwner owner)
    {
        if (ClaudeRuntimeState.IsExternal(owner.Entry.Snapshot().AuthorityEnvelope))
            return;
        if (!Stale(owner, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))
            return;
        try
        {
            await RefreshSnapshotAsync(owner);
            owner.SnapshotRefreshWarning = null;
        }
        catch (Exception error)
        {
            owner.SnapshotRefreshWarning = error.Message;
            owner.Entry.RecordBestEffortFailure(error);
            Console.Error.WriteLine(
                $"Failed to refresh stale Session '{owner.Id}' snapshot; continuing turn: {error.Message}"
            );
        }
    }

    // Commands in skill output name the same Agent as the call they answer.
    private static string AgentFlag(JsonObject args) =>
        args["agentName"] is { } raw && SessionWait.Text(raw)?.Trim() is { Length: > 0 } agent
            ? " --agent-name " + agent
            : "";

    // The commands that reach this skill's files, each named only when the caller might be
    // allowed to use it for this skill (the visibility help uses), as one sentence.
    private string ResourceCommands(SessionOwner source, string skill, JsonObject args)
    {
        var flag = AgentFlag(args);
        JsonObject Known(JsonObject value)
        {
            if (args["agentName"] is { } agent)
                value["agentName"] = agent.DeepClone();
            return value;
        }
        var clauses = new List<string> { $"Read a resource with `ctl skill load {skill} <path>{flag}`" };
        if (ToolVisible(source, "builtin", "skill", fixedArgs: Known(new() { ["action"] = "copy", ["skillName"] = skill })))
            clauses.Add($"copy files to a Node with `ctl skill copy {skill} <target-path> --path <path>{flag}`");
        if (ToolVisible(source, "builtin", "run_skill", fixedArgs: Known(new() { ["skillName"] = skill })))
            clauses.Add($"run a ToolScript file with `ctl skill run {skill} --script <path>{flag}`");
        return (
            clauses.Count == 1 ? clauses[0]
            : string.Join(", ", clauses.Take(clauses.Count - 1)) + " and " + clauses[^1]
        ) + ".";
    }

    internal async Task<JsonObject> SkillAsync(SessionOwner source, JsonObject args)
    {
        Keys(args, ["action", "skillName", "agentName", "startLine", "endLine"], ["action"]);
        if (args.ContainsKey("startLine") || args.ContainsKey("endLine"))
            throw new InvalidDataException("startLine and endLine apply only to a resource path.");
        var agent = Skills.RequestedAgent(OptionalString(args, "agentName"), source.Agent);
        var action = RequiredString(args, "action").Trim().ToLowerInvariant();
        if (action == "list")
        {
            // Filtered like the catalog, from the caller's live context; an unavailable policy
            // fails this call as it fails every call.
            var access = SkillAccessFor(VisibilityFor(source), OptionalString(args, "agentName"));
            var list = (await skills.ListAsync(agent))
                .Where(info => access(info) != SkillAccess.Hidden)
                .ToArray();
            return new JsonObject
            {
                ["agent"] = agent,
                ["skills"] = new JsonArray(
                    list.Select(info =>
                        {
                            var skill = new JsonObject { ["name"] = info.Name };
                            if (!string.IsNullOrEmpty(info.Description))
                                skill["description"] = info.Description;
                            skill["source"] = info.SourceLabel;
                            return (JsonNode?)skill;
                        })
                        .ToArray()
                ),
            };
        }
        if (action != "load")
            throw new InvalidDataException("skill.action must be \"list\" or \"load\".");
        var name = RequiredString(args, "skillName");
        var (info, content) = await skills.LoadAsync(name, agent);
        // Resources are reached through the skill subsystem from any Node; the Main server path
        // is shown only where Node tools resolve it (user decision 2026-11-25, U8).
        var output =
            $"Skill: {info.Name}"
            + (string.IsNullOrEmpty(info.Description) ? "" : $"\nDescription: {info.Description}")
            + $"\nSource: {info.SourceLabel}\nPaths in this skill are relative to its directory. {ResourceCommands(source, info.Name, args)}"
            + (
                Capabilities.MasterNode && CurrentNode(source) == "master"
                    ? $"\nOn master, the skill directory is {info.Directory}."
                    : ""
            );
        if (info.Resources.Length > 0)
            output +=
                "\n\nSkill resources (supporting files, not eagerly loaded):\n"
                + string.Join('\n', info.Resources.Select(path => "- " + path))
                + (info.ResourcesTruncated ? "\n- ... (resource listing truncated)" : "");
        return Output(output + $"\n\nFILE: {info.Name}/SKILL.md\n{content}\n");
    }
}
