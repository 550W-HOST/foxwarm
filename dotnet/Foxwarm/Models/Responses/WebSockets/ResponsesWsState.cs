using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record WsPrefix(string Hash, int ItemCount);

internal sealed record WsFingerprint(
    string Invariant,
    IReadOnlyList<WsPrefix> Prefixes,
    WsPrefix Final
);

internal static class ResponsesWsState
{
    private const string Domain = "foxwarm-openai-responses-ws-prefix-v1";

    private static string Digest(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    internal static WsFingerprint Fingerprint(JsonObject body)
    {
        var invariant = (JsonObject)body.DeepClone();
        invariant.Remove("input");
        invariant.Remove("stream");
        invariant.Remove("previous_response_id");
        var hash = "sha256:" + ModelRoutingFingerprint.Hash(invariant);
        var prefixes = new List<WsPrefix>();
        var current = new WsPrefix(Digest(Domain + "\0" + hash), 0);
        foreach (var item in body["input"] as JsonArray ?? [])
        {
            current = Extend(current, [item]);
            prefixes.Add(current);
        }
        return new(hash, prefixes, current);
    }

    internal static WsPrefix Extend(WsPrefix prefix, IEnumerable<JsonNode?> items)
    {
        foreach (var item in items)
        {
            var count = prefix.ItemCount + 1;
            prefix = new(
                Digest(Domain + "\0" + prefix.Hash + "\0" + count + "\0" + Canonical(item)),
                count
            );
        }
        return prefix;
    }

    private static string Canonical(JsonNode? node)
    {
        JsonNode? Sorted(JsonNode? value)
        {
            if (value is JsonArray array)
                return new JsonArray(array.Select(Sorted).ToArray());
            if (value is JsonObject obj)
            {
                var result = new JsonObject();
                foreach (var key in obj.Select(pair => pair.Key).Order(StringComparer.Ordinal))
                    result[key] = Sorted(obj[key]);
                return result;
            }
            return value?.DeepClone();
        }
        return node is null ? "null" : EcmaJson.Stringify(Sorted(node)!);
    }
}
