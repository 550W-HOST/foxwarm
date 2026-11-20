using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class MainLocalToolDefinitions
{
    private static JsonObject String(string description) =>
        new() { ["type"] = "string", ["description"] = description };

    private static JsonObject Number(string description) =>
        new() { ["type"] = "number", ["description"] = description };

    private static JsonObject Parameters(JsonObject properties, params string[] required) =>
        new()
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = new JsonArray(
                required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["additionalProperties"] = false,
        };

    private static JsonObject Tool(string name, string description, JsonObject parameters) =>
        new()
        {
            ["type"] = "function",
            ["name"] = name,
            ["description"] = description,
            ["strict"] = false,
            ["parameters"] = parameters,
        };

    private const string MemoryPath =
        "Path relative to the memory directory, without a memory/ prefix.";

    private const string InjectedMemory =
        "Top-level .md files in a memory directory are part of the system prompt of every Session of that Agent and of Agents that inherit it.";

    private static JsonObject MemoryAgent() =>
        String("Exact name of the Agent whose memory directory to use. Omit for this Agent.");

    internal static JsonArray Definitions() =>
        [
            Tool(
                "read_memory",
                "Read a file in an Agent's memory directory on master: this Agent's, or the Agent named by agentName. Use memory-relative paths such as MEMORY.md or notes/project.md.",
                Parameters(
                    new JsonObject
                    {
                        ["filePath"] = String(MemoryPath),
                        ["startLine"] = Number(
                            "First line to read, counting from 1. Omit or use 0 to start at the beginning."
                        ),
                        ["endLine"] = Number(
                            "Last line to read, counting from 1. Omit or use 0 to read through the end."
                        ),
                        ["agentName"] = MemoryAgent(),
                    },
                    "filePath"
                )
            ),
            Tool(
                "write_memory",
                "Create a file in an Agent's memory directory on master: this Agent's, or the Agent named by agentName. Existing files are not overwritten; use edit_memory to modify one. " + InjectedMemory,
                Parameters(
                    new JsonObject
                    {
                        ["filePath"] = String(MemoryPath),
                        ["content"] = String("Complete file contents."),
                        ["agentName"] = MemoryAgent(),
                    },
                    "filePath",
                    "content"
                )
            ),
            Tool(
                "edit_memory",
                "Replace one exact occurrence of text in a file in an Agent's memory directory on master: this Agent's, or the Agent named by agentName. " + InjectedMemory,
                Parameters(
                    new JsonObject
                    {
                        ["filePath"] = String(MemoryPath),
                        ["oldText"] = String(
                            "Exact text to replace; it must identify a single occurrence."
                        ),
                        ["newText"] = String("Replacement text."),
                        ["agentName"] = MemoryAgent(),
                    },
                    "filePath",
                    "oldText",
                    "newText"
                )
            ),
            Tool(
                "delete_memory",
                "Delete one file from an Agent's memory directory on master: this Agent's, or the Agent named by agentName.",
                Parameters(
                    new JsonObject
                    {
                        ["filePath"] = String(MemoryPath),
                        ["agentName"] = MemoryAgent(),
                    },
                    "filePath"
                )
            ),
            Tool(
                "apply_patch_memory",
                "Add, modify, or delete files in an Agent's memory directory on master using the apply_patch format: this Agent's, or the Agent named by agentName. Paths in patch headers are relative to the memory directory; a memory/ prefix is also accepted. " + InjectedMemory,
                Parameters(
                    new JsonObject
                    {
                        ["input"] = String("Patch text using the same format as apply_patch."),
                        ["agentName"] = MemoryAgent(),
                    },
                    "input"
                )
            ),
            Tool(
                "generate_image",
                "Generate or edit an image with the selected model's configured image service. Returns visible images that can be saved or delivered with the image tools. Use imageIds to reference images from this session for edits; describe the requested result in prompt.",
                Parameters(
                    new JsonObject
                    {
                        ["prompt"] = String("Describe the image to generate or the edit to make."),
                        ["imageIds"] = new JsonObject
                        {
                            ["type"] = "array",
                            ["maxItems"] = 8,
                            ["items"] = String("Image ID shown in this session."),
                            ["description"] =
                                "Optional source images for editing or visual reference.",
                        },
                    },
                    "prompt"
                )
            ),
            Tool(
                "image_crop",
                "Crop an image from this Session, including a generated image or one returned by a tool. Returns a new visible image/reference, which can be cropped, saved, or delivered again. GIF input uses its first frame and returns a PNG, without animation. Coordinates and dimensions refer to the original image, before resizing for model input.",
                Parameters(
                    new JsonObject
                    {
                        ["id"] = String("Image ID shown in this Session."),
                        ["x"] = Number("Left edge of the crop, in pixels."),
                        ["y"] = Number("Top edge of the crop, in pixels."),
                        ["width"] = Number("Crop width in pixels."),
                        ["height"] = Number("Crop height in pixels."),
                    },
                    "id",
                    "x",
                    "y",
                    "width",
                    "height"
                )
            ),
            Tool(
                "list_agents",
                "List Agents with their Session counts, memory metadata, inheritance and rule summary. The list shows your own Agent and the Agents your tool policy may let you use.",
                Parameters(new JsonObject())
            ),
        ];
}
