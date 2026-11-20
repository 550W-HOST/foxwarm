using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Legacy isolation is no longer settable or enforced. Tests that relied on it either seed the
// retained legacy fields before startup (to exercise the migration) or install the layer the
// migration generates for an equivalent legacy Agent.
internal static class LegacyIsolationFixture
{
    internal static JsonArray Layer(string agent, string? node, JsonArray? toolRules = null) =>
        IsolationMigrationRules
            .Generate(
                agent,
                IsolatedToolCompatibility.Metadata(
                    new JsonObject
                    {
                        ["isolated"] = true,
                        ["isolatedNode"] = node,
                        ["toolRules"] = toolRules?.DeepClone() ?? new JsonArray(),
                    }
                ),
                retainedMainLayout: false
            )
            .Rules;

    /// <summary>
    /// Restricts an existing Agent as the startup migration would restrict an isolated Agent
    /// bound to <paramref name="node"/>: the generated layer plus the default Node.
    /// </summary>
    internal static async Task RestrictAsync(
        SessionManager manager,
        string agent,
        string? node,
        JsonArray? toolRules = null
    )
    {
        await manager.SetAgentRulesAsync(agent, Layer(agent, node, toolRules));
        if (node is not null)
            await manager.SetAgentDefaultPlacementAsync(agent, true, node, false, null);
    }
}
