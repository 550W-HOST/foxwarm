using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class KnowledgeToolDefinitions
{
    internal static JsonObject[] Definitions() =>
    [
        new()
        {
            ["type"] = "function", ["name"] = "skill", ["strict"] = false,
            ["description"] = "List available skills or read a skill's instructions and resource list. Skills may come from the agent, its inherited agents, or the global collection. Read any needed resource files separately; loading instructions does not enable additional tools.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object", ["additionalProperties"] = false, ["required"] = new JsonArray("action"),
                ["properties"] = new JsonObject
                {
                    ["action"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("list", "load"), ["description"] = "list shows available skills; load reads one skill." },
                    ["skillName"] = new JsonObject { ["type"] = "string", ["description"] = "Skill to read when action is load." },
                    ["agentName"] = new JsonObject { ["type"] = "string", ["description"] = "Agent whose available skills to use. Defaults to this session's agent." }
                }
            }
        },
        new()
        {
            ["type"] = "function", ["name"] = "set_agent_inherit", ["strict"] = false,
            ["description"] = "Set or clear an agent's shared-memory inheritance. Memory is included from the oldest ancestor through the agent itself; files with the same name are not deduplicated. Existing session snapshots are unchanged unless refreshSnapshots is true.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object", ["additionalProperties"] = false, ["required"] = new JsonArray("agentName"),
                ["properties"] = new JsonObject
                {
                    ["agentName"] = new JsonObject { ["type"] = "string", ["description"] = "Agent to update." },
                    ["inheritAgentName"] = new JsonObject { ["type"] = "string", ["description"] = "Agent to inherit from. An empty string clears inheritance." },
                    ["refreshSnapshots"] = new JsonObject { ["type"] = "boolean", ["default"] = false, ["description"] = "Refresh snapshots now for this agent and its inheriting agents, skipping sessions inactive for more than one hour because they refresh automatically when their next turn starts. Defaults to false." }
                }
            }
        }
    ];
}
