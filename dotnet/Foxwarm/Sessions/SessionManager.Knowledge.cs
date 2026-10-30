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
        parent = string.IsNullOrWhiteSpace(parent) ? null : parent.Trim();
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
        return new { affectedSessions = affected.ToArray(), inheritanceChain = AgentChain(name) };
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

    internal async Task<JsonObject> SkillAsync(SessionOwner source, JsonObject args)
    {
        Keys(args, ["action", "skillName", "agentName"], ["action"]);
        var agent = OptionalString(args, "agentName");
        agent = string.IsNullOrWhiteSpace(agent) ? source.Agent : agent.Trim();
        var action = RequiredString(args, "action").Trim().ToLowerInvariant();
        if (action == "list")
        {
            var list = await skills.ListAsync(agent);
            if (list.Count == 0)
                return Output($"No skills found for agent \"{agent}\".");
            return Output(
                $"Found {list.Count} skill(s) for agent \"{agent}\":\n\n"
                    + string.Join(
                        '\n',
                        list.Select(info =>
                            $"- **{info.Name}** [{info.SourceLabel}]"
                            + (
                                string.IsNullOrEmpty(info.Description)
                                    ? ""
                                    : $" - {info.Description}"
                            )
                            + " (1 document)"
                        )
                    )
            );
        }
        if (action != "load")
            throw new InvalidDataException("skill.action must be \"list\" or \"load\".");
        var name = RequiredString(args, "skillName");
        var (info, content) = await skills.LoadAsync(name, agent);
        var output =
            $"Skill: {info.Name}"
            + (string.IsNullOrEmpty(info.Description) ? "" : $"\nDescription: {info.Description}")
            + $"\nSource: {info.SourceLabel}\nMetadata: {info.MetadataPath}\nSkill directory: {info.Directory}\nRelative paths in this skill are relative to the skill directory.";
        if (info.Resources.Length > 0)
            output +=
                "\n\nSkill resources (supporting files, not eagerly loaded):\n"
                + string.Join('\n', info.Resources.Select(path => "- " + path))
                + (info.ResourcesTruncated ? "\n- ... (resource listing truncated)" : "");
        return Output(output + $"\n\nFILE: {info.MetadataPath}\n{content}\n");
    }
}
