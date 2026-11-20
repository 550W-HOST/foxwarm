using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// The browser_* contract comes from the host bundle, so the model-facing schemas and copy exist
// once. Without a usable node and bundle nothing is registered.
internal static class MainBrowserDefinitions
{
    internal static JsonArray All(BrowserHost? host = null) =>
        new(
            (host ?? new BrowserHost(BrowserHost.DefaultBundlePath()))
                .Describe()
                .Tools.OfType<JsonObject>()
                .Select(tool =>
                    (JsonNode)
                        new JsonObject
                        {
                            ["type"] = "function",
                            ["strict"] = false,
                            ["name"] = tool["name"]!.DeepClone(),
                            ["description"] = tool["description"]!.DeepClone(),
                            ["parameters"] = tool["parameters"]!.DeepClone(),
                        }
                )
                .ToArray()
        );
}
