using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class FileDeliveryDefinitions
{
    internal static JsonArray Definitions() =>
        new(
            Definition(
                "copy_between_nodes",
                "Copy a file between Nodes, including master. Both paths are checked against the applicable permissions. If the copy outlasts timeout, it continues in the background and returns a transferId; a later event reports completion. Stop or Run queued ends the wait without cancelling the copy; use cancel_transfer to stop it.",
                new JsonObject
                {
                    ["sourceNode"] = String("Node containing the source file."),
                    ["sourcePath"] = String(
                        "Source file path on sourceNode. A relative path uses the Session working directory when the Node is this Session's current Node and a working directory is set, otherwise the Node's default directory (the Agent directory on master and CLI Nodes). On master and CLI Nodes, ~/ and a leading $fw_agentdir or $fw_tmp are accepted; other leading $ names are rejected."
                    ),
                    ["targetNode"] = String("Node that will receive the file."),
                    ["targetPath"] = String(
                        "Destination file path on targetNode. Relative paths follow the same rule as sourcePath."
                    ),
                    ["overwrite"] = new JsonObject
                    {
                        ["type"] = "boolean",
                        ["description"] =
                            "Allow replacement of an existing destination file. Defaults to false.",
                    },
                    ["timeout"] = new JsonObject
                    {
                        ["type"] = "number",
                        ["minimum"] = 1,
                        ["description"] =
                            "Seconds to wait before returning a still-running copy as a background transfer. Defaults to 15; values above 60 are reduced to 60 with a warning.",
                    },
                },
                "sourceNode",
                "sourcePath",
                "targetNode",
                "targetPath"
            ),
            Definition(
                "cancel_transfer",
                "Cancel a background copy started by copy_between_nodes in this Session. Already transferred bytes are not undone: an unfinished copy publishes nothing on master and CLI Nodes, while other Nodes may keep a partial destination file.",
                new JsonObject
                {
                    ["transferId"] = String("Transfer ID returned by copy_between_nodes."),
                },
                "transferId"
            ),
            Definition(
                "send_file",
                "Deliver a file or image from a Node to users. Choose either one channelTargetId or a sessionId whose attached channels should receive it. With neither, delivery uses the current Session.",
                new JsonObject
                {
                    ["channelTargetId"] = String(
                        "One destination in the form <channel-instance-id>:<conversation-id>. Do not combine with sessionId."
                    ),
                    ["sessionId"] = String(
                        "Session whose attached channels should receive the file. Defaults to the current Session; do not combine with channelTargetId."
                    ),
                    ["filePath"] = String(
                        "File path on the selected Node. A relative path uses the Session working directory when the Node is this Session's current Node and a working directory is set, otherwise the Node's default directory (the Agent directory on master and CLI Nodes). On master and CLI Nodes, ~/ and a leading $fw_agentdir or $fw_tmp are accepted; other leading $ names are rejected."
                    ),
                    ["node"] = String("Node containing the file. Defaults to the current Node."),
                    ["caption"] = String(
                        "Text to accompany the file, where the destination supports captions."
                    ),
                },
                "filePath"
            ),
            Definition(
                "image_write_to_file",
                "Save an image from this Session, including a generated image or one returned by a tool. The saved file can be reused or delivered with send_file.",
                new JsonObject
                {
                    ["id"] = String("Image ID shown in this Session."),
                    ["filePath"] = String(
                        "File path on the selected Node. A relative path uses the Session working directory when the Node is this Session's current Node and a working directory is set, otherwise the Node's default directory (the Agent directory on master and CLI Nodes). On master and CLI Nodes, ~/ and a leading $fw_agentdir or $fw_tmp are accepted; other leading $ names are rejected."
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
