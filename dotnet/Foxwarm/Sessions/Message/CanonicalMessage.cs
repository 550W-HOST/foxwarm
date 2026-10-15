using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed class CanonicalMessage
{
    private readonly JsonObject json;
    public string Role { get; }
    public IReadOnlyList<MessagePartView> Parts { get; }

    private CanonicalMessage(JsonObject owned, string role, List<MessagePartView> parts)
    {
        json = owned;
        Role = role;
        Parts = parts;
    }

    public static CanonicalMessage Parse(string text)
    {
        var node =
            JsonNode.Parse(text) as JsonObject
            ?? throw new FormatException("Message must be a JSON object.");
        return FromOwned(node);
    }

    public static CanonicalMessage FromNode(JsonObject input)
        => FromOwned((JsonObject)input.DeepClone());

    private static CanonicalMessage FromOwned(JsonObject owned)
    {
        var role =
            owned["role"]?.GetValue<string>()
            ?? throw new FormatException("Message role is required.");
        if (role is not ("user" or "model" or "tool"))
            throw new FormatException($"Unsupported message role: {role}");
        if (owned["parts"] is not JsonArray parts)
            throw new FormatException("Message parts must be an array.");
        var views = new List<MessagePartView>(parts.Count);
        foreach (var part in parts)
        {
            if (part is not JsonObject partObject)
                throw new FormatException("Message parts must contain objects.");
            views.Add(new MessagePartView(partObject));
        }
        return new CanonicalMessage(owned, role, views);
    }

    internal static bool IsVisible(JsonObject input)
    {
        var role = input["role"]?.GetValue<string>()
            ?? throw new FormatException("Message role is required.");
        if (role is not ("user" or "model" or "tool"))
            throw new FormatException($"Unsupported message role: {role}");
        if (input["parts"] is not JsonArray parts)
            throw new FormatException("Message parts must be an array.");
        if (parts.Any(part => part is not JsonObject))
            throw new FormatException("Message parts must contain objects.");
        return input["modelVisible"] is not JsonValue value
            || !value.TryGetValue<bool>(out var visible) || visible;
    }

    internal static bool IsVisible(HistoryMessage input)
    {
        var json = input.Data;
        var role = HistoryMessage.Text(json, "role")
            ?? throw new FormatException("Message role is required.");
        if (role is not ("user" or "model" or "tool"))
            throw new FormatException($"Unsupported message role: {role}");
        if (!json.TryGetProperty("parts", out var parts) || parts.ValueKind != JsonValueKind.Array)
            throw new FormatException("Message parts must be an array.");
        foreach (var part in parts.EnumerateArray())
            if (part.ValueKind != JsonValueKind.Object)
                throw new FormatException("Message parts must contain objects.");
        return input.IsModelVisible;
    }

    public JsonObject ToJson() => (JsonObject)json.DeepClone();

    public bool HasModelVisible => json.ContainsKey("modelVisible");
    public bool IsModelVisible =>
        json["modelVisible"] is not JsonValue value
        || !value.TryGetValue<bool>(out var visible)
        || visible;

    public static IReadOnlyList<CanonicalMessage> FilterModelVisible(
        IEnumerable<CanonicalMessage> messages
    ) => messages.Where(message => message.IsModelVisible).ToList();
}

public sealed class MessagePartView
{
    private readonly JsonObject json;

    internal MessagePartView(JsonObject owned) => json = owned;

    public bool Has(string property) => json.ContainsKey(property);

    public JsonNode? Get(string property) => json[property]?.DeepClone();

    public string? GetString(string property) => json[property]?.GetValue<string>();

    public JsonObject ToJson() => (JsonObject)json.DeepClone();
}
