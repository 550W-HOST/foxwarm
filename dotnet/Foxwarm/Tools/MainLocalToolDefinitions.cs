using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class MainLocalToolDefinitions
{
    private static JsonObject String(string description) => new() { ["type"] = "string", ["description"] = description };
    private static JsonObject Number(string description) => new() { ["type"] = "number", ["description"] = description };
    private static JsonObject Parameters(JsonObject properties, params string[] required) => new()
    {
        ["type"] = "object", ["properties"] = properties,
        ["required"] = new JsonArray(required.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()),
        ["additionalProperties"] = false
    };
    private static JsonObject Tool(string name, string description, JsonObject parameters) => new()
    {
        ["type"] = "function", ["name"] = name, ["description"] = description, ["strict"] = false, ["parameters"] = parameters
    };

    internal static JsonArray Definitions() =>
    [
        Tool("read_memory", "Read a file in this agent's memory directory on master. Use memory-relative paths such as MEMORY.md or notes/project.md.", Parameters(new JsonObject
        {
            ["filePath"] = String("Path relative to this agent's memory directory, without a memory/ prefix."),
            ["startLine"] = Number("First line to read, counting from 1. Omit or use 0 to start at the beginning."),
            ["endLine"] = Number("Last line to read, counting from 1. Omit or use 0 to read through the end.")
        }, "filePath")),
        Tool("write_memory", "Create a file in this agent's memory directory on master. Existing files are not overwritten; use edit_memory to modify one.", Parameters(new JsonObject
        {
            ["filePath"] = String("Path relative to this agent's memory directory, without a memory/ prefix."),
            ["content"] = String("Complete file contents.")
        }, "filePath", "content")),
        Tool("edit_memory", "Replace one exact occurrence of text in a file in this agent's memory directory on master.", Parameters(new JsonObject
        {
            ["filePath"] = String("Path relative to this agent's memory directory, without a memory/ prefix."),
            ["oldText"] = String("Exact text to replace; it must identify a single occurrence."),
            ["newText"] = String("Replacement text.")
        }, "filePath", "oldText", "newText")),
        Tool("delete_memory", "Delete one file from this agent's memory directory on master.", Parameters(new JsonObject
        {
            ["filePath"] = String("Path relative to this agent's memory directory, without a memory/ prefix.")
        }, "filePath")),
        Tool("apply_patch_memory", "Add, modify, or delete files in this agent's memory directory on master using the apply_patch format. Paths in patch headers are relative to the memory directory; a memory/ prefix is also accepted.", Parameters(new JsonObject
        {
            ["input"] = String("Patch text using the same format as apply_patch.")
        }, "input")),
        Tool("image_crop", "Crop an image from this session, including a generated image or one returned by a tool. Returns a new visible image/reference, which can be cropped, saved, or delivered again. GIF input uses its first frame and returns a PNG, without animation.", Parameters(new JsonObject
        {
            ["id"] = String("Image ID shown in this session."), ["x"] = Number("Left edge of the crop, in pixels."), ["y"] = Number("Top edge of the crop, in pixels."), ["width"] = Number("Crop width in pixels."), ["height"] = Number("Crop height in pixels.")
        }, "id", "x", "y", "width", "height")),
        Tool("list_agents", "List the agents and their current session counts, memory metadata, inheritance, isolation, and tool-rule summary without hydrating every Session.", Parameters(new JsonObject()))
    ];
}