using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm;

/// <summary>Text encoding shared by Main, Node clients and Desktop hosts.</summary>
public static class JsonText
{
    public static JavaScriptEncoder Encoder => JavaScriptEncoder.UnsafeRelaxedJsonEscaping;

    private static readonly JsonSerializerOptions Compact = new()
    {
        Encoder = Encoder,
        // Match JsonNode.ToJsonString() without options, not the serializer's 64-level default.
        MaxDepth = 1000,
    };
    private static readonly JsonSerializerOptions Indented = new()
    {
        Encoder = Encoder,
        WriteIndented = true,
    };
    private static readonly JsonSerializerOptions Html = new()
    {
        Encoder = JavaScriptEncoder.Default,
    };

    /// <summary>JSON text for files, wire messages and readable output, not HTML embedding.</summary>
    public static string ToJsonText(this JsonNode node, bool indented = false) =>
        node.ToJsonString(indented ? Indented : Compact);

    /// <summary>
    /// A JSON literal embedded in HTML script text. HTML attributes still require HTML encoding.
    /// </summary>
    public static string ToHtmlJson(this JsonNode node) => node.ToJsonString(Html);
}
