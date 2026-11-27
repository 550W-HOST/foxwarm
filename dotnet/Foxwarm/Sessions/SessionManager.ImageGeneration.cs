using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private SessionOwner.ToolModelSelection? ImageGenerationModel(SessionOwner owner)
    {
        var catalog = models.Capture();
        var selected = catalog.Select(owner.Entry.Snapshot());
        if (
            owner.Processing
            && owner.ToolModel is { } current
            && current.RawModel == selected.RawModel
        )
            return current;
        return selected.Model.IsVirtual ? null : new(catalog, selected.Model, selected.RawModel);
    }

    internal static string ImageFailureMessage(Exception error, ConcreteHostModel model)
    {
        var reason = error is ModelRequestException request
            ? request.Final.Reason
            : ModelAttemptFailure.Summary(ConfiguredModelRequests.SafeError(error, model));
        return "Image generation failed: " + reason;
    }

    private bool UsesSeparateImageGeneration(SessionOwner owner) =>
        ImageGenerationModel(owner) is { } selected
        && ImageGenerationRequests.UsesSeparateRequest(selected.Model);

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
        var selection = ImageGenerationModel(owner);
        if (selection is null || !ImageGenerationRequests.UsesSeparateRequest(selection.Model))
            throw new InvalidDataException(
                "Separate image generation is not enabled for the selected concrete model."
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
            Capabilities.Egress,
            websockets: websockets,
            images: Images,
            journal: Journal,
            diagnostics: diagnostics,
            retryIntervals: models.GetRetryIntervals,
            secrets: secrets
        );
        ChatResult result;
        try
        {
            result = await ImageGenerationRequests.RequestAsync(
                requests,
                selection.Catalog,
                selection.Model,
                owner.Id,
                owner.LogicalTurnId,
                inputParts,
                owner.Entry.RecordBestEffortFailure,
                token
            );
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (SessionTurnShutdownException)
        {
            throw;
        }
        catch (Exception error)
        {
            // A failed image request is this tool's result, never the turn's model failure:
            // request-owner exceptions would otherwise escape tool dispatch, end the turn and
            // leave the function call without a persisted response.
            throw new InvalidDataException(ImageFailureMessage(error, selection.Model), error);
        }
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
            throw new InvalidDataException("Image generation returned no usable image.");
        return new JsonObject
        {
            ["output"] =
                images.Count == 1 ? "Generated one image." : $"Generated {images.Count} images.",
            ["imageParts"] = images,
        };
    }
}
