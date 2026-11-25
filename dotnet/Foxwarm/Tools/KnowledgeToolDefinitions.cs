using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class KnowledgeToolDefinitions
{
    internal static JsonObject[] Definitions() =>
        [
            new()
            {
                ["type"] = "function",
                ["name"] = "skill",
                ["strict"] = false,
                ["description"] =
                    "List available skills, read a skill's instructions or one of its resources, or copy skill files to a Node. Skills may come from the Agent, its inherited Agents, or the global collection. Loading instructions does not enable additional tools.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("action"),
                    ["properties"] = new JsonObject
                    {
                        ["action"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["enum"] = new JsonArray("list", "load", "copy"),
                            ["description"] =
                                "list shows available skills; load reads a skill or one of its resources; copy copies skill files to a Node.",
                        },
                        ["skillName"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Skill to read when action is load.",
                        },
                        ["path"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Resource inside the skill, relative to its directory. For load, omit to read the skill's instructions and resource list; for copy, omit to copy the whole skill.",
                        },
                        ["startLine"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["description"] = "First line of the resource to read, counting from 1.",
                        },
                        ["endLine"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["description"] = "Last line of the resource to read.",
                        },
                        ["targetPath"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Destination: a file when --path names a file, otherwise a directory that receives the files. A relative path uses the Session working directory when the Node is this Session's current Node and a working directory is set, otherwise the Node's default directory (the Agent directory on master and CLI Nodes).",
                        },
                        ["node"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Node that receives the files. Defaults to the current Node.",
                        },
                        ["overwrite"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["description"] = "Allow replacement of existing destination files. Defaults to false.",
                        },
                        ["agentName"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Agent whose available skills to use. Defaults to this Session's Agent.",
                        },
                    },
                },
            },
            new()
            {
                ["type"] = "function",
                ["name"] = "set_agent_inherit",
                ["strict"] = false,
                ["description"] =
                    "Set or clear an agent's shared-memory inheritance. Memory is included from the oldest ancestor through the agent itself; files with the same name are not deduplicated. Existing session snapshots are unchanged unless refreshSnapshots is true.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["required"] = new JsonArray("agentName"),
                    ["properties"] = new JsonObject
                    {
                        ["agentName"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = "Agent to update.",
                        },
                        ["inheritAgentName"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Agent to inherit from. An empty string clears inheritance.",
                        },
                        ["refreshSnapshots"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["default"] = false,
                            ["description"] =
                                "Refresh snapshots now for this agent and its inheriting agents, skipping sessions inactive for more than one hour because they refresh automatically when their next turn starts. Defaults to false.",
                        },
                    },
                },
            },
        ];
}
