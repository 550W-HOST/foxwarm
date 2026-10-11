using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal static class RemoteNodeResult
{
    // Only documented old Node image carriers are normalized here. Peer values
    // remain data; none can produce a Main control receipt, cwd commit or file path.
    internal static JsonNode? Normalize(JsonNode? raw)
    {
        var result = raw?.DeepClone();
        if (result is not JsonObject value) return result;
        value.Remove("__foxwarmResolvedToolPaths");
        if (value["inlineData"] is JsonObject || value["inlineDataItems"] is JsonArray) return value;
        string? data = null;
        string? mime = null;
        if (SessionWait.Text(value["output"]) is string output)
        {
            if (output.StartsWith("__IMAGE__:", StringComparison.Ordinal))
            {
                var parts = output.Split(':', 3);
                if (parts.Length == 3 && parts[1].StartsWith("image/", StringComparison.Ordinal) && parts[2].Length > 0) { mime = parts[1]; data = parts[2]; }
            }
            else if (output.StartsWith("__SCREENSHOT__:", StringComparison.Ordinal) && output.Length > 15) { data = output[15..]; mime = "image/png"; }
            if (data is not null) value.Remove("output");
        }
        if (data is null && SessionWait.Text(value["image"]) is { Length: > 0 } image && SessionWait.Text(value["encoding"])?.Equals("base64", StringComparison.OrdinalIgnoreCase) == true)
        {
            mime = SessionWait.Text(value["mimeType"]);
            if (mime?.StartsWith("image/", StringComparison.Ordinal) != true)
            {
                var format = SessionWait.Text(value["format"])?.Trim().ToLowerInvariant();
                mime = string.IsNullOrEmpty(format) ? null : format == "jpg" ? "image/jpeg" : format.Contains('/') ? format : "image/" + format;
            }
            if (mime?.StartsWith("image/", StringComparison.Ordinal) == true) { data = image; value.Remove("image"); value.Remove("encoding"); value.Remove("format"); }
        }
        if (data is null && SessionWait.Text(value["screenshot"]) is { Length: > 0 } screenshot && SessionWait.Text(value["mimeType"]) is string screenshotMime && screenshotMime.StartsWith("image/", StringComparison.Ordinal)) { data = screenshot; mime = screenshotMime; value.Remove("screenshot"); }
        if (data is not null) value["inlineData"] = new JsonObject { ["data"] = data, ["mimeType"] = mime };
        return value;
    }
}
