using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal static class ProviderImageParts
{
    internal static bool IsImage(JsonObject part) => part["inlineData"] is JsonObject || part["inlineDataRef"] is JsonObject || Foxwarm.Images.ProviderImageDedup.IsDeduplicated(part);
    internal static JsonObject? Block(JsonObject part, string protocol)
    {
        if (part["inlineData"] is not JsonObject inline)
        {
            if (part["inlineDataRef"] is not null && !Foxwarm.Images.ProviderImageDedup.IsDeduplicated(part))
                throw new ModelPreparationException("Image reference was not hydrated before provider serialization.");
            return null;
        }
        var mime = SessionWait.Text(inline["mimeType"]) ?? SessionWait.Text(inline["mime_type"]) ?? "image/jpeg";
        var data = SessionWait.Text(inline["data"]) ?? "";
        return protocol switch
        {
            "responses" => new JsonObject { ["type"] = "input_image", ["image_url"] = "data:" + mime + ";base64," + data },
            "completions" => new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = "data:" + mime + ";base64," + data } },
            _ => new JsonObject { ["type"] = "image", ["source"] = new JsonObject { ["type"] = "base64", ["media_type"] = mime, ["data"] = data } }
        };
    }
    internal static List<(string Id, List<JsonObject> Parts)> ToolGroups(IEnumerable<JsonObject> parts)
    {
        var groups = new List<(string Id, List<JsonObject> Parts)>(); var lookup = new Dictionary<string, List<JsonObject>>(StringComparer.Ordinal); var pending = new List<JsonObject>();
        List<JsonObject> Group(string id)
        {
            if (lookup.TryGetValue(id, out var values)) return values;
            values = []; lookup.Add(id, values); groups.Add((id, values)); return values;
        }
        foreach (var part in parts)
        {
            var response = part["functionResponse"] as JsonObject;
            var id = SessionWait.Text(response?["tool_use_id"]) ?? SessionWait.Text(part["toolUseId"]);
            if (response is not null)
            {
                if (string.IsNullOrEmpty(id)) throw new ModelPreparationException("Tool response needs a stable call ID.");
                var group = Group(id); group.AddRange(pending); pending.Clear(); group.Add(part);
            }
            else if (IsImage(part))
            {
                if (string.IsNullOrEmpty(id)) pending.Add(part); else Group(id).Add(part);
            }
        }
        return groups;
    }
    internal static JsonArray GroupBlocks(IEnumerable<JsonObject> parts, string protocol)
    {
        var result = new JsonArray(); var textType = protocol == "responses" ? "input_text" : "text";
        foreach (var part in parts)
        {
            if (part["functionResponse"] is JsonObject response)
            {
                if (OpenAIRequestText.PreviousRequest(response) is { } timing) result.Insert(0, new JsonObject { ["type"] = textType, ["text"] = timing });
                var text = ToolResponseFormatting.Format(response["response"] as JsonObject ?? new JsonObject());
                if (text.Length > 0) result.Add(new JsonObject { ["type"] = textType, ["text"] = text });
            }
            else
            {
                if (SessionWait.Text(part["text"]) is { Length: > 0 } text) result.Add(new JsonObject { ["type"] = textType, ["text"] = text });
                if (Block(part, protocol) is { } image) result.Add(image);
            }
        }
        return result;
    }
}
