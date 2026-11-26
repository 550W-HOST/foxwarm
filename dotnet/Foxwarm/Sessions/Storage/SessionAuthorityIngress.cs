using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Cold ingress after a load has normalized the authority value: history, queue and meta
/// images are externalized into the image store, then the value becomes a snapshot. Every
/// authority representation loads through it.
/// </summary>
internal static class SessionAuthorityIngress
{
    internal static async Task<SessionSnapshot> FromNormalizedAsync(
        Foxwarm.Images.ImageBlobStore images,
        JsonObject normalized,
        string sessionId,
        CancellationToken cancellationToken
    )
    {
        foreach (var message in ((JsonArray)normalized["history"]!).OfType<JsonObject>())
            await images.ExternalizeMessageAsync(message, strict: false, cancellationToken);
        var loaded = SessionAuthorityCodec.FromAuthority(normalized, sessionId);
        foreach (var item in loaded.Queue)
        {
            if (item.Message is not null)
                await images.ExternalizeMessageAsync(
                    item.Message,
                    strict: false,
                    cancellationToken
                );
            if (item.Parts is not null)
            {
                var wrapper = new JsonObject
                {
                    ["parts"] = new JsonArray(
                        item.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
                    ),
                };
                await images.ExternalizeMessageAsync(wrapper, strict: false, cancellationToken);
                foreach (var (part, index) in item.Parts.Select((part, index) => (part, index)))
                    if (wrapper["parts"] is JsonArray parts && parts.Count == item.Parts.Count)
                    {
                        part.Clear();
                        foreach (var pair in parts[index]!.AsObject())
                            part[pair.Key] = pair.Value?.DeepClone();
                    }
            }
        }
        await images.ExternalizeTreeAsync(loaded.Meta, strict: false, cancellationToken);
        return loaded;
    }
}
