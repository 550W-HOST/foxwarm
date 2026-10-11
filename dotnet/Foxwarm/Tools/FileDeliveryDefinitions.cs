using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class FileDeliveryDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            Definition(
                "copy_between_nodes",
                "Copy a file between two Nodes, including master. Both paths are checked against the applicable permissions. Relative paths use this agent's directory on each Node, not the session working directory.",
                new JsonObject
                {
                    ["sourceNode"] = String(
                        "Node containing the source file. Use master for the Main host."
                    ),
                    ["sourcePath"] = String(
                        "Source path on sourceNode. Absolute paths, ~/ paths, and paths relative to the agent directory are accepted. On Main and CLI Nodes, a leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected."
                    ),
                    ["targetNode"] = String(
                        "Node that will receive the file. Use master for the Main host."
                    ),
                    ["targetPath"] = String(
                        "Destination path on targetNode. Absolute paths, ~/ paths, and paths relative to the agent directory are accepted. On Main and CLI Nodes, a leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected."
                    ),
                    ["overwrite"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] =
                            "Allow replacement of an existing destination file. Defaults to false.",
                    },
                },
                "sourceNode",
                "sourcePath",
                "targetNode",
                "targetPath"
            ),
            Definition(
                "send_file",
                "Deliver a file or image from a Node to users. Choose either one channelTargetId or a sessionId whose attached channels should receive it. With neither, delivery uses the current session.",
                new JsonObject
                {
                    ["channelTargetId"] = String(
                        "One destination in the form <channel-instance-id>:<conversation-id>. Do not combine with sessionId."
                    ),
                    ["sessionId"] = String(
                        "Session whose attached channels should receive the file. Defaults to the current session; do not combine with channelTargetId."
                    ),
                    ["filePath"] = String(
                        "Path on the selected Node. On master, relative paths use the current session working directory or, if unset, its agent directory. On other Nodes, they use that Node's agent directory. Absolute paths and ~/ paths are accepted. On Main and CLI Nodes, a leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected."
                    ),
                    ["node"] = String("Node containing the file. Defaults to the current Node."),
                    ["caption"] = String(
                        "Text to accompany the file, where the destination supports captions."
                    ),
                    ["text"] = String("Alternative name for caption."),
                },
                "filePath"
            ),
            Definition(
                "image_write_to_file",
                "Save an image from this session, including a generated image or one returned by a tool. The saved file can be reused or delivered with send_file.",
                new JsonObject
                {
                    ["id"] = String("Image ID shown in this session."),
                    ["filePath"] = String(
                        "Destination path. On master, relative paths use the session working directory or, if unset, the agent directory. On other Nodes, they use that Node's agent directory. Absolute paths and ~/ paths are also accepted. On Main and CLI Nodes, a leading $fw_agentdir or $fw_tmp expands to this Agent's directory or its tmp directory. Other leading $ names are rejected."
                    ),
                    ["overwrite"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] =
                            "Allow replacement of an existing file. Defaults to false.",
                    },
                    ["node"] = String(
                        "Node on which to save the image. Defaults to the current Node."
                    ),
                },
                "id",
                "filePath"
            )
        );

    private static JsonObject String(string description) =>
        new() { ["type"] = "string", ["description"] = description };

    private static JsonObject Definition(
        string name,
        string description,
        JsonObject properties,
        params string[] required
    ) =>
        new()
        {
            ["type"] = "function",
            ["name"] = name,
            ["description"] = description,
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = properties,
                ["required"] = new JsonArray(
                    required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                ),
            },
            ["strict"] = false,
        };
}
