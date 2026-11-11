using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private bool UsesIsolatedImageGeneration(SessionOwner owner)
    {
        var selected = models.Capture().Select(owner.Entry.Snapshot()).Model;
        return selected.Configuration["imageGeneration"]?["enabled"]?.GetValue<bool>() == true
            && SessionWait.Text(selected.Configuration["imageGeneration"]?["mode"]) == "isolated";
    }

    internal async Task<JsonObject> GenerateImageAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["prompt", "imageIds"]);
        var prompt = ToolRegistry.Text(args, "prompt");
        if (string.IsNullOrWhiteSpace(prompt) || prompt.Length > 65536)
            throw new InvalidDataException(
                "generate_image requires a nonempty prompt of at most 65536 characters."
            );
        if (args.ContainsKey("imageIds") && args["imageIds"] is not JsonArray)
            throw new InvalidDataException(
                "imageIds must be an array of image IDs from this session."
            );
        var ids = args["imageIds"] as JsonArray ?? [];
        if (ids.Count > 8 || ids.Any(id => string.IsNullOrWhiteSpace(SessionWait.Text(id))))
            throw new InvalidDataException(
                "imageIds must contain at most eight nonempty image IDs."
            );

        await WaitForIdentityMutationAsync(owner.Id, token);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Image generation caller is no longer the current Session owner."
            );
        var catalog = models.Capture();
        var selection = catalog.Select(owner.Entry.Snapshot());
        if (selection.Model.IsVirtual)
            throw new InvalidDataException(
                "Select a concrete Responses model for image generation."
            );
        if (selection.Model.Configuration["imageGeneration"]?["enabled"]?.GetValue<bool>() != true)
            throw new InvalidDataException(
                "Image generation is not enabled for the selected model."
            );

        var inputParts = new JsonArray(new JsonObject { ["text"] = prompt });
        foreach (var id in ids.Select(SessionWait.Text).Distinct(StringComparer.Ordinal))
        {
            var image =
                FindOwnedImage(owner.History().Reverse(), id!)
                ?? FindOwnedImage(
                    owner
                        .Archive.ReadEffectiveMessagesRange(1, 9007199254740991L)
                        .Reverse()
                        .Select(row => row.Message),
                    id!
                );
            if (image is null)
                throw new InvalidDataException("Image ID was not found in this session: " + id);
            var input = new JsonObject();
            if (image["inlineDataRef"] is JsonObject reference)
                input["inlineDataRef"] = reference.DeepClone();
            else if (image["inlineData"] is JsonObject inline)
                input["inlineData"] = inline.DeepClone();
            else
                throw new InvalidDataException("Source image bytes are unavailable: " + id);
            if (image["imageMeta"] is JsonObject metadata)
                input["imageMeta"] = metadata.DeepClone();
            inputParts.Add(input);
        }

        var requests = new ModelRequestOwner(
            http,
            clientOptions,
            modelRouting,
            websockets: websockets,
            images: Images,
            journal: Journal,
            diagnostics: diagnostics,
            retryIntervals: models.GetRetryIntervals,
            secrets: secrets
        );
        var request = requests.Capture(catalog, selection.Model.Key, null);
        var result = await requests.RequestAsync(
            owner.Id,
            request,
            "image-" + Guid.NewGuid().ToString("N"),
            owner.LogicalTurnId,
            [new JsonObject { ["role"] = "user", ["parts"] = inputParts }],
            (_, _) =>
                Task.FromResult(
                    "Generate or edit the requested image. Use the image generation tool and return the image. Follow the user's visual requirements."
                ),
            null,
            null,
            null,
            owner.Entry.RecordBestEffortFailure,
            token,
            ModelRequestScope.LowLevel,
            () => new JsonArray(),
            null,
            "image-generation",
            0,
            maxAttempts: 1
        );
        result.FinalizeHistory(null);
        token.ThrowIfCancellationRequested();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Image generation caller is no longer the current Session owner."
            );
        var parts = result.AssistantMessage?["parts"] as JsonArray ?? [];
        var images = new JsonArray(
            parts
                .OfType<JsonObject>()
                .Where(part => ImageBlobStore.NormalizeToolReference(part) is not null)
                .Select(part => (JsonNode?)part.DeepClone())
                .ToArray()
        );
        if (images.Count == 0)
        {
            var evidence = parts
                .OfType<JsonObject>()
                .Where(part =>
                    part["providerMeta"]?["openaiResponses"]?["imageGenerationFailure"] is not null
                )
                .Select(part => SessionWait.Text(part["text"]))
                .Where(text => !string.IsNullOrEmpty(text));
            var detail = string.Join("\n", evidence);
            throw new InvalidDataException(
                detail.Length > 0 ? detail : "Image generation returned no usable image."
            );
        }
        return new JsonObject
        {
            ["output"] =
                images.Count == 1 ? "Generated one image." : $"Generated {images.Count} images.",
            ["imageParts"] = images,
        };
    }
}
