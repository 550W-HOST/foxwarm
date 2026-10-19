namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal Func<string, string, Task>? BeforeAgentDeletionStage { get; set; }

    internal Task<string[]> DeleteAgentAsync(string name) => DeleteAgentCoreAsync(name, command: false);

    internal Task<string[]> DeleteAgentFromCommandAsync(string name) => DeleteAgentCoreAsync(name, command: true);

    private async Task<string[]> DeleteAgentCoreAsync(string name, bool command)
    {
        await EnsureIdentityStartupAsync();
        agents.ValidateDeletion(name, command);
        using var lifetime = TrackCreation();
        var pending = ClaimAgentRemoval(name);
        try
        {
            if (BeforeAgentDeletionStage is { } before)
                await before(name, "claimed");
            await Task.WhenAll(pending);
            agents.ValidateDeletion(name, command);
            var rows = Catalog.List();
            var selected = rows.Where(row => command
                ? SessionCatalog.Text(row["id"])!.StartsWith(name + "/", StringComparison.Ordinal)
                : (SessionCatalog.Text(row["agent"]) ?? "main") == name).ToArray();
            var ids = selected.Select(row => SessionCatalog.Text(row["id"])!).ToArray();
            if (!command)
            {
                var inheritedBy = agents.MetadataSnapshot()
                    .Where(pair => pair.Key != name && SessionCatalog.Text(pair.Value?["inherit"]) == name)
                    .Select(pair => pair.Key).ToArray();
                if (inheritedBy.Length > 0)
                    throw new InvalidOperationException(
                        $"Agent \"{name}\" is inherited by: {string.Join(", ", inheritedBy)}. Clear those inheritance links first."
                    );
                var busy = selected.Where(row => SessionCatalog.Flag(row["busy"])
                    || Find(SessionCatalog.Text(row["id"])!) is { } owner && (owner.Metadata().Busy || owner.Processing))
                    .Select(row => SessionCatalog.Text(row["id"])!).ToArray();
                if (busy.Length > 0)
                    throw new InvalidOperationException($"Agent \"{name}\" has active sessions: {string.Join(", ", busy)}");
                var blocked = deletionChannels.Blockers(deletionChannels.Read(), ids);
                if (blocked.Count > 0)
                    throw new InvalidOperationException(
                        $"Agent \"{name}\" has sessions attached to non-WebUI channels: {string.Join(", ", blocked.Select(row => SessionCatalog.Text(row!["sessionId"])).Distinct())}"
                    );
            }
            var deleted = new List<string>();
            foreach (var id in ids)
            {
                var result = command
                    ? await DeleteCoreAsync(id, recursive: false, source: null, agentCommand: true)
                    : await DeleteAsync(id, recursive: false, source: null);
                if (SessionCatalog.Text(result["status"]) == "busy")
                    throw new InvalidOperationException(SessionCatalog.Text(result["message"]));
                if (SessionCatalog.Text(result["status"]) != "deleted")
                    throw new InvalidOperationException($"Agent deletion stopped because session \"{id}\" could not be deleted.");
                deleted.Add(id);
            }
            var remaining = Catalog.List().Where(row => (SessionCatalog.Text(row["agent"]) ?? "main") == name)
                .Select(row => SessionCatalog.Text(row["id"])!).ToArray();
            if (remaining.Length > 0 && (!command || name != "main"))
                throw new InvalidOperationException(command
                    ? $"Agent \"{name}\" still owns Sessions outside this command's selection. Its folder was kept; earlier deletions were not rolled back."
                    : $"Agent deletion stopped because new owned sessions appeared: {string.Join(", ", remaining)}");
            await agents.RemoveDeletedAsync(name, retainMetadata: command, BeforeAgentDeletionStage);
            TopologyChanged?.Invoke();
            return deleted.ToArray();
        }
        finally
        {
            lock (lifecycle)
                removingAgents.Remove(name);
        }
    }
}
