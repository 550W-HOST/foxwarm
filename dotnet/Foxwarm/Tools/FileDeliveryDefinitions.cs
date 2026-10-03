using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class FileDeliveryDefinitions
{
    internal static JsonArray Definitions() => new(
        Definition("send_file", "Make a Main file available for download through WebUI. Choose a Session's attached destinations or one explicit destination; with neither, use the current session. The tool result lets the user download the file. WebUI destination checks do not post a notification in the target chat.",
            new JsonObject
            {
                ["channelTargetId"] = String("One destination in the form <channel-instance-id>:<conversation-id>. Do not combine with sessionId."),
                ["sessionId"] = String("Session whose attached destinations should be used. Defaults to this session; do not combine with channelTargetId."),
                ["filePath"] = String("File on Main. Relative paths use this session's working directory, or the agent directory when unset. Absolute paths, ~/ paths, and leading $fw_agentdir or $fw_tmp are accepted subject to permissions. Other leading $ names are rejected."),
                ["node"] = String("File source Node. Defaults to the current Node. This host supports master only."),
                ["caption"] = String("Text to accompany the file where the destination supports captions."),
                ["text"] = String("Alternative name for caption.")
            }, "filePath"),
        Definition("image_write_to_file", "Save an image from this session's current or archived history to a Main file. Original bytes are preserved; the filename does not change the format. The saved file can be reused or made available with send_file.",
            new JsonObject
            {
                ["id"] = String("Image ID shown in this session."),
                ["filePath"] = String("Destination path. Relative paths use this session's working directory, or the agent directory when unset. Absolute paths, ~/ paths, and leading $fw_agentdir or $fw_tmp are accepted subject to permissions. Other leading $ names are rejected."),
                ["overwrite"] = new JsonObject { ["type"] = "boolean", ["description"] = "Allow replacement of an existing file. Defaults to false." },
                ["node"] = String("Destination Node. Defaults to the current Node. This host supports master only.")
            }, "id", "filePath"));
    private static JsonObject String(string description) => new() { ["type"] = "string", ["description"] = description };
    private static JsonObject Definition(string name, string description, JsonObject properties, params string[] required) => new()
    {
        ["type"] = "function", ["name"] = name, ["description"] = description,
        ["parameters"] = new JsonObject { ["type"] = "object", ["properties"] = properties, ["required"] = new JsonArray(required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()) },
        ["strict"] = false
    };
}
