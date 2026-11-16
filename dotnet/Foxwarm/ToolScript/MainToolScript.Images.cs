using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.ToolScript;

// Image references a script may return. A result part's `inlineDataRef` makes the next model
// request read that stored blob, so a script may return only images it can already reach:
// blobs referenced in its own Session's history, and blobs that were image results of its
// nested calls and model requests in this run. A nested result counts only when the call
// produced it as an image result (the parts the host externalized from the tool response, or
// image parts of a model answer), never reference-shaped data anywhere in a result, and only
// from a capability whose image results are its own: any authorized capability that is not
// self-exempt, a nested script (whose returned images passed this same admission), or
// image_crop (a new image cropped from the caller's own history). Inline bytes a script
// returns are its own data and need no admission.
internal sealed partial class MainToolScript
{
    private const int ProducedImageLimit = 1024;

    // Self-exempt capabilities whose image results the run may return.
    private static readonly HashSet<string> SelfImageProducers = new(StringComparer.Ordinal)
    {
        "run_script",
        "start_toolscript_run",
        "continue_script",
        "get_toolscript_run",
        "image_crop",
    };

    // Whether the image results of a nested call count as produced in this run.
    internal static bool ProducesImages(Foxwarm.Tools.ResolvedTool resolved) =>
        Foxwarm.Tools.OperationPlan.SelfReason(resolved) is null
        || resolved.Source == "builtin" && SelfImageProducers.Contains(resolved.Name);

    // Records a stored blob that a nested call produced as an image result.
    private static void NoteProducedImage(JsonObject record, string blob)
    {
        var produced = record["producedImages"] as JsonArray;
        if (produced is not null && produced.Any(item => Text(item) == blob))
            return;
        if (produced?.Count >= ProducedImageLimit)
            return;
        produced ??= (JsonArray)(record["producedImages"] = new JsonArray());
        produced.Add((JsonNode?)blob);
    }

    // Records the image parts of a model answer; its text can't carry a reference.
    private static void NoteModelImages(JsonObject record, JsonObject answer)
    {
        foreach (var part in (answer["parts"] as JsonArray ?? []).OfType<JsonObject>())
            if (
                Foxwarm.Images.ImageBlobStore.NormalizeToolReference(part) is { } reference
                && Text(reference["blobId"]) is { Length: > 0 } blob
            )
                NoteProducedImage(record, blob);
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
