using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.ToolScript;

// Image references a script may return. A result part's `inlineDataRef` makes the next model
// request read that stored blob, so a script may return only images it can already reach:
// blobs referenced in its own Session's history, and blobs produced during this run by its
// nested tool calls and model requests, each of which passed its own authorization. Inline
// bytes a script returns are its own data and need no admission.
internal sealed partial class MainToolScript
{
    private const int ProducedImageLimit = 1024;

    // Records the stored blobs a nested call or model request returned to the script.
    private static void NoteProducedImages(JsonObject record, JsonNode? value)
    {
        if (value is null)
            return;
        var produced = record["producedImages"] as JsonArray;
        var known = produced is null
            ? new HashSet<string>(StringComparer.Ordinal)
            : produced.Select(Text).OfType<string>().ToHashSet(StringComparer.Ordinal);
        foreach (var blob in BlobIds(value))
        {
            if (known.Count >= ProducedImageLimit || !known.Add(blob))
                continue;
            produced ??= (JsonArray)(record["producedImages"] = new JsonArray());
            produced.Add((JsonNode?)blob);
        }
    }

    private static IEnumerable<string> BlobIds(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject value:
                if (
                    Text(value["blobId"]) is { Length: > 0 } blob
                    && Text(value["sha256"]) is not null
                )
                    yield return blob;
                foreach (var (_, child) in value)
                foreach (var id in BlobIds(child))
                    yield return id;
                break;
            case JsonArray list:
                foreach (var child in list)
                foreach (var id in BlobIds(child))
                    yield return id;
                break;
        }
    }

    // The stored images of a completed result that the run may return; any other reference
    // fails the run before anything reads the blob.
    internal static JsonArray AdmitResultImages(
        SessionOwner owner,
        JsonObject record,
        JsonNode? result
    )
    {
        var admitted = new JsonArray();
        if (result is not JsonObject value || value["parts"] is not JsonArray parts)
            return admitted;
        var produced = (record["producedImages"] as JsonArray ?? [])
            .Select(Text)
            .OfType<string>()
            .ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var part in parts.OfType<JsonObject>())
        {
            if (Foxwarm.Images.ImageBlobStore.NormalizeToolReference(part) is not { } reference)
                continue;
            var blob = Text(reference["blobId"])!;
            if (!seen.Add(blob))
                continue;
            if (!produced.Contains(blob) && !SessionManager.HistoryReferencesImage(owner, blob))
                throw new InvalidDataException(
                    $"The script returned image `{Text(reference["imageId"]) ?? blob}`, which it can't return. A script may return images from this Session's history or produced by calls it made in this run."
                );
            admitted.Add((JsonNode?)blob);
        }
        return admitted;
    }
}
