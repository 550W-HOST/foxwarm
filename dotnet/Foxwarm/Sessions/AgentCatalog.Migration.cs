using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    /// <summary>
    /// Installation reader level this binary understands. Level 1 adds the
    /// <c>inheritable: false</c> flag and legacy-isolation migration markers. Binaries that
    /// predate the marker ignore it, so it only protects downgrades between binaries that read it.
    /// </summary>
    internal const int ReaderVersion = 1;

    internal const string InstallationFileName = "installation.json";

    internal string InstallationPath =>
        Path.Combine(Path.GetDirectoryName(indexPath)!, InstallationFileName);

    internal static int? MinimumReaderVersion(string installationPath)
    {
        if (!File.Exists(installationPath))
            return null;
        var document =
            JsonNode.Parse(File.ReadAllText(installationPath)) as JsonObject
            ?? throw new InvalidDataException("Installation metadata must be an object.");
        var value = document["minimumReaderVersion"];
        if (value is null)
            return null;
        if (value is not JsonValue number || !number.TryGetValue<int>(out var level) || level < 1)
            throw new InvalidDataException(
                "Installation minimumReaderVersion must be a positive integer."
            );
        return level;
    }

    private void RequireReaderVersion()
    {
        var required = MinimumReaderVersion(InstallationPath);
        if (required > ReaderVersion)
            throw new InvalidDataException(
                $"This installation requires a Foxwarm Main that reads installation level {required}; this binary reads level {ReaderVersion}. Upgrade Main instead of downgrading."
            );
    }

    // The lowest reader level that understands every row. Each level counts only data its
    // predecessors would ignore; creator links and local rules are enforced by earlier
    // binaries and raise nothing.
    internal static int RequiredReaderLevel(JsonObject metadata) =>
        metadata.Any(pair =>
            pair.Value is JsonObject row
            && (row.ContainsKey("legacyIsolation") || !Inheritable(row))
        )
            ? 1
            : 0;

    /// <summary>
    /// Raises the installation marker before metadata that depends on this reader is
    /// written. The marker only increases, so a later failed metadata write leaves it harmless.
    /// </summary>
    private void EnsureReaderVersion(JsonObject next)
    {
        var level = RequiredReaderLevel(next);
        if (level == 0 || MinimumReaderVersion(InstallationPath) >= level)
            return;
        var path = InstallationPath;
        var document = File.Exists(path)
            ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject
                ?? throw new InvalidDataException("Installation metadata must be an object.")
            : new JsonObject();
        document["minimumReaderVersion"] = level;
        new LinuxAtomicJsonFile(
            Path.GetDirectoryName(path)!,
            InstallationFileName
        ).WriteTextPayload(document.ToJsonString(), default);
    }

    /// <summary>
    /// Publishes one isolation migration as a single metadata write: the generated local
    /// layer, <c>inheritable: false</c>, the default Node when unset, and the migration
    /// marker. Legacy <c>isolated</c>, <c>isolatedNode</c> and <c>toolRules</c> stay as
    /// the downgrade fence. Returns the default-Node conflict, if any.
    /// </summary>
    internal async Task<string?> ApplyIsolationMigrationAsync(
        string name,
        Func<AgentIsolation, IsolationMigrationPlan> plan,
        long migratedAt
    )
    {
        await createGate.WaitAsync();
        try
        {
            if (!Exists(name))
                throw new InvalidDataException("Agent not found.");
            var next = MetadataSnapshot();
            var row = next[name] as JsonObject ?? new JsonObject();
            next[name] = row;
            var isolation = IsolatedToolCompatibility.Metadata(row);
            if (Inheritors(name) is { Length: > 0 } inheritors)
                throw new InvalidDataException(
                    $"Agent '{name}' is inherited by {string.Join(", ", inheritors)}; change their inheritance first."
                );
            if (row.ContainsKey("legacyIsolation"))
                throw new InvalidDataException("Agent isolation is already migrated.");
            if (row["rules"] is JsonArray { Count: > 0 })
                throw new InvalidDataException(
                    "Agent already has local rules; merge the generated layer manually."
                );
            var generated = plan(isolation);
            if (generated.Blockers.Count > 0)
                throw new InvalidDataException(string.Join(" ", generated.Blockers));
            _ = AgentRulePolicy.Parse(generated.Rules);
            row["rules"] = generated.Rules.DeepClone();
            row["inheritable"] = false;
            string? conflict = null;
            if (isolation.RecordedNode is { } node)
            {
                var existing = SessionWait.Text(row["defaultNode"]);
                if (existing is null)
                    row["defaultNode"] = node;
                else if (existing != node)
                    conflict = existing;
            }
            row["legacyIsolation"] = new JsonObject
            {
                ["node"] = isolation.RecordedNode,
                ["migratedAt"] = migratedAt,
                ["generator"] = IsolationMigrationRules.GeneratorVersion,
                ["rulesDigest"] = generated.Digest,
            };
            try
            {
                AtomicIndexWrite(
                    indexPath,
                    Payload(List().Where(id => id != "main"), next).ToJsonString()
                );
            }
            catch (AuthorityCommittedException)
            {
                lock (stateGate)
                    metadata = next;
                throw;
            }
            lock (stateGate)
                metadata = next;
            return conflict;
        }
        finally
        {
            createGate.Release();
        }
    }

    /// <summary>
    /// Publishes one metadata change of the startup isolation migration. <paramref name="mutate"/>
    /// edits a copy of the metadata and returns whether anything changed; the copy is
    /// validated like any other catalog write and published as one atomic write.
    /// </summary>
    internal async Task<bool> MigrateMetadataAsync(Func<JsonObject, bool> mutate)
    {
        await createGate.WaitAsync();
        try
        {
            var next = MetadataSnapshot();
            if (!mutate(next))
                return false;
            foreach (var (_, value) in next)
            {
                _ = IsolatedToolCompatibility.Metadata(value);
                if (value is JsonObject row && row["rules"] is JsonArray rules)
                    _ = AgentRulePolicy.Parse(rules);
            }
            EnsureReaderVersion(next);
            try
            {
                AtomicIndexWrite(
                    indexPath,
                    Payload(List().Where(id => id != "main"), next).ToJsonString()
                );
            }
            catch (AuthorityCommittedException)
            {
                lock (stateGate)
                    metadata = next;
                throw;
            }
            lock (stateGate)
                metadata = next;
            return true;
        }
        finally
        {
            createGate.Release();
        }
    }
}
