using System.Text.Json.Nodes;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // The one running WebUI adapter provides path readiness, not a target notification.
    private Action<string, string, string?>? webUiFileDelivery;
    internal void RegisterWebUiFileDelivery(Action<string, string, string?>? handler) => Volatile.Write(ref webUiFileDelivery, handler);
    internal void AttachWebUi(string requested, SessionOwner? owner = null)
    {
        using var admission = owner is null ? BeginMutation([requested]) : BeginOwnerMutation(owner);
        var id = owner?.Id ?? requested;
        if (Catalog.Get(id) is null) throw new InvalidOperationException("WebUI ingress Session is no longer available.");
        deletionChannels.Attach("webui:" + id, id);
    }
    internal Task<JsonObject> SendFileAsync(SessionOwner owner, WorkspaceTools files, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["channelTargetId", "sessionId", "filePath", "node", "caption", "text"]);
        ToolRegistry.LocalNode(ToolRegistry.Text(args, "node"));
        var raw = SessionGoal.Trim(ToolRegistry.Text(args, "filePath") ?? "");
        if (raw.Length == 0) throw new InvalidDataException("send_file requires filePath.");
        var requested = SessionGoal.Trim(ToolRegistry.Text(args, "sessionId") ?? "");
        var direct = SessionGoal.Trim(ToolRegistry.Text(args, "channelTargetId") ?? "");
        if (requested.Length > 0 && direct.Length > 0) throw new InvalidDataException("At most one of sessionId or channelTargetId may be specified.");
        var caption = SessionGoal.Trim(ToolRegistry.Text(args, "caption") ?? "");
        if (caption.Length == 0) caption = SessionGoal.Trim(ToolRegistry.Text(args, "text") ?? "");
        token.ThrowIfCancellationRequested();
        using var admission = BeginOwnerMutation(owner);
        var bindings = deletionChannels.ReadForDelivery()["channels"]!.AsObject();
        var target = direct.Length > 0 ? null : FileSession(requested.Length > 0 ? requested : owner.Id);
        var destinations = direct.Length > 0 ? [direct] : bindings.Where(pair => SessionCatalog.Text(pair.Value?["sessionId"]) == target)
            .Select(pair => pair.Key).ToArray();
        CheckFileDestinations(owner, target, direct, bindings);
        if (destinations.Length == 0) throw new InvalidDataException($"Session `{target}` has no attached channels.");
        var path = files.Paths.FilePath(raw);
        if (!WorkspaceTools.RegularFile(path)) throw new InvalidDataException("Not a regular file: " + raw);
        var name = Path.GetFileName(path);
        var delivered = new List<string>(); var skipped = new List<string>(); var failed = new List<string>();
        foreach (var destination in destinations)
        {
            token.ThrowIfCancellationRequested();
            var colon = destination.IndexOf(':');
            if (colon <= 0 || colon == destination.Length - 1) throw new InvalidDataException("Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>.");
            if (direct.Length == 0 && SessionCatalog.Text(bindings[destination]?["mode"]) == "send-only") { skipped.Add($"`{destination}` (send-only)"); continue; }
            try
            {
                if (destination[..colon] != "webui") throw new InvalidDataException("Channel instance is not available: " + destination[..colon]);
                var conversation = destination[(colon + 1)..];
                var bound = SessionCatalog.Text(bindings[destination]?["sessionId"]);
                _ = FileSession(bound ?? conversation);
                var handler = Volatile.Read(ref webUiFileDelivery) ?? throw new InvalidOperationException("WebUI file delivery is unavailable.");
                owner.Entry.RequireIdentityAuthority();
                if (!IsCurrentOwner(owner)) throw new InvalidOperationException("File source Session is no longer current.");
                handler(conversation, path, caption.Length > 0 ? caption : null);
                delivered.Add(destination);
            }
            catch (Exception error) when (error is InvalidDataException or InvalidOperationException or IOException)
            {
                if (direct.Length > 0) throw;
                failed.Add($"`{destination}` ({error.Message})");
            }
        }
        var lines = new List<string> { $"File `{name}` is ready for session `{target ?? direct}`.", "Delivered: " + delivered.Count };
        if (delivered.Count > 0) lines.Add("Channels: " + string.Join(", ", delivered.Select(id => "`" + id + "`")));
        if (skipped.Count > 0) lines.Add("Skipped: " + string.Join(", ", skipped));
        if (failed.Count > 0) lines.Add("Failed: " + string.Join(", ", failed));
        var output = string.Join("\n", lines);
        if (delivered.Count == 0) throw new InvalidOperationException(output);
        return Task.FromResult(new JsonObject { ["output"] = output, ["fullPath"] = path });
    }
    private string FileSession(string requested) => SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"])
        ?? throw new InvalidDataException("Session is not available: " + requested);
    private void CheckFileDestinations(SessionOwner owner, string? target, string direct, JsonObject bindings)
    {
        if (!Isolation(owner.Agent).Isolated) return;
        if (target is not null && target != owner.Id) throw new ToolAuthorizationDeniedException("Isolated Session can only send files via its own current Session attachments.");
        if (direct.Length > 0 && SessionCatalog.Text(bindings[direct]?["sessionId"]) != owner.Id)
            throw new ToolAuthorizationDeniedException("Isolated Session can only send files to its own attached destination.");
    }
    internal Func<string, string, Task>? BeforeFileStage { get; set; }
    private async Task FileStageAsync(SessionOwner owner, string stage)
    {
        if (BeforeFileStage is { } before) await before(owner.Id, stage);
        var marker = Path.Combine(root, "state", "experiment-faults", SessionIdentity.ExecDirectorySegment(owner.Id) + ".file-" + stage + "-hold");
        if (!File.Exists(marker)) return;
        await File.WriteAllTextAsync(marker + ".reached", "reached"); var deadline = DateTime.UtcNow.AddSeconds(15);
        while (File.Exists(marker) && DateTime.UtcNow < deadline) await Task.Delay(2);
        if (File.Exists(marker)) throw new TimeoutException("Experimental file barrier expired.");
    }
    internal async Task<JsonObject> ExportImageAsync(SessionOwner owner, WorkspaceTools files, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["id", "filePath", "overwrite", "node"]);
        ToolRegistry.LocalNode(ToolRegistry.Text(args, "node"));
        var id = ToolRegistry.Text(args, "id"); var raw = ToolRegistry.Text(args, "filePath");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(raw)) throw new InvalidDataException("image_write_to_file requires id and filePath.");
        var overwrite = OptionalBool(args, "overwrite") ?? false;
        using var admission = BeginOwnerMutation(owner);
        var match = FindOwnedImage(owner.History().Reverse(), id);
        match ??= FindOwnedImage(owner.Archive.ReadEffectiveMessagesRange(1, 9007199254740991L).Reverse().Select(row => row.Message), id);
        if (match is null) throw new InvalidDataException($"Image id `{id}` not found in session `{owner.Id}`.");
        var bytes = match["inlineDataRef"] is JsonObject reference ? await Images.ReadAsync(reference, token)
            : match["inlineData"] is JsonObject inline ? Foxwarm.Images.ImageBlobStore.InlineBytes(inline)
            : throw new InvalidDataException("Image original bytes are unavailable.");
        await FileStageAsync(owner, "before-effect");
        // Resolve after image I/O from the current owner, then authorize that exact effect context.
        while (true)
        {
            await WaitForIdentityMutationAsync(owner.Id, token);
            var identity = owner.Id; files = IdentityWorkspace(owner);
            await AuthorizeToolAsync(owner, new("image_write_to_file", "builtin", "image_write_to_file", args), files, token);
            if (identity == owner.Id) break;
        }
        var path = files.Paths.FilePath(raw);
        token.ThrowIfCancellationRequested(); owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner)) throw new InvalidOperationException("Image source Session is no longer current.");
        if (Directory.Exists(path) || !overwrite && (File.Exists(path) || new FileInfo(path).LinkTarget is not null)) throw new IOException("File already exists: " + raw + ". Use overwrite=true to overwrite.");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path) && !WorkspaceTools.RegularFile(path)) throw new IOException("Image target must be a regular file.");
        if (!await FileToolCore.WriteBytesAtomic(path, bytes, overwrite, () => _ = files.Paths.FilePath(raw), token)) throw new IOException("File already exists: " + raw + ". Use overwrite=true to overwrite.");
        try { await FileStageAsync(owner, "after-write"); }
        catch (Exception error) when (error is IOException or InvalidOperationException or OperationCanceledException or TimeoutException)
        {
            var partial = UnsupportedTurnToolExecutor.ToolError("image_export_partial", "Image was written; a later step failed. The file was not removed or retried. " + error.Message);
            partial["fileWritten"] = true; partial["fullPath"] = path; return partial;
        }
        return new JsonObject { ["output"] = $"Image `{id}` written to `{raw}` on node `master`.\nYou can make it available with send_file.", ["fullPath"] = path };
    }
    internal async Task<JsonObject> CropImageAsync(SessionOwner owner, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["id", "x", "y", "width", "height"]);
        var id = ToolRegistry.Text(args, "id"); if (string.IsNullOrWhiteSpace(id)) throw new InvalidDataException("image_crop requires id.");
        int Number(string key) { var value = SessionWait.Number(args[key]); if (value is null || value != Math.Truncate(value.Value) || value < int.MinValue || value > int.MaxValue) throw new InvalidDataException("image_crop requires integer x, y, width, and height values."); return (int)value.Value; }
        var x = Number("x"); var y = Number("y"); var width = Number("width"); var height = Number("height");
        if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new InvalidDataException("image_crop requires x >= 0, y >= 0, width > 0, and height > 0.");
        using var admission = BeginOwnerMutation(owner);
        var match = FindOwnedImage(owner.History().Reverse(), id) ?? FindOwnedImage(owner.Archive.ReadEffectiveMessagesRange(1, 9007199254740991L).Reverse().Select(row => row.Message), id);
        if (match is null) throw new InvalidDataException($"Image id `{id}` not found in session `{owner.Id}`.");
        var bytes = match["inlineDataRef"] is JsonObject reference ? await Images.ReadAsync(reference, token) : match["inlineData"] is JsonObject inline ? Foxwarm.Images.ImageBlobStore.InlineBytes(inline) : throw new InvalidDataException("Image original bytes are unavailable.");
        var mime = Foxwarm.Images.ImageBlobStore.Mime(match["inlineDataRef"] as JsonObject ?? match["inlineData"] as JsonObject ?? new JsonObject());
        if (!Foxwarm.Images.RasterCodec.IsSafeRaster(mime)) throw new InvalidDataException("image_crop supports PNG, JPEG, and WebP images on this host.");
        if (mime == "image/gif") throw new InvalidDataException("image_crop cannot encode GIF output on this host; use PNG, JPEG, or WebP input.");
        var probe = Foxwarm.Images.RasterCodec.Inspect(bytes, mime); if ((long)x + width > probe.Width || (long)y + height > probe.Height) throw new InvalidDataException($"Crop rectangle ({x}, {y}, {width}, {height}) exceeds source image bounds {probe.Width}x{probe.Height}.");
        using var data = SKData.CreateCopy(bytes); using var codec = SKCodec.Create(data) ?? throw new InvalidDataException("Image raster is invalid.");
        using var source = new SKBitmap(new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul)); if (codec.GetPixels(source.Info, source.GetPixels()) != SKCodecResult.Success) throw new InvalidDataException("Image pixel decoding failed.");
        using var cropped = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul)); if (!source.ExtractSubset(cropped, new SKRectI(x, y, x + width, y + height))) throw new InvalidDataException("Image crop failed.");
        var format = mime switch { "image/jpeg" => SKEncodedImageFormat.Jpeg, "image/webp" => SKEncodedImageFormat.Webp, "image/gif" => SKEncodedImageFormat.Gif, _ => SKEncodedImageFormat.Png };
        using var image = SKImage.FromBitmap(cropped); using var encoded = image.Encode(format, 90) ?? throw new InvalidDataException("Image crop encoding failed."); var outputBytes = encoded.ToArray(); var outputMime = format == SKEncodedImageFormat.Jpeg ? "image/jpeg" : format == SKEncodedImageFormat.Webp ? "image/webp" : format == SKEncodedImageFormat.Gif ? "image/gif" : "image/png";
        return new JsonObject { ["output"] = $"[Cropped image from {id}]", ["sourceImageId"] = id, ["crop"] = new JsonObject { ["x"] = x, ["y"] = y, ["width"] = width, ["height"] = height }, ["mimeType"] = outputMime, ["sizeBytes"] = outputBytes.Length, ["inlineData"] = new JsonObject { ["mimeType"] = outputMime, ["data"] = Convert.ToBase64String(outputBytes) } };
    }
    private static JsonObject? FindOwnedImage(IEnumerable<JsonObject> messages, string id)
    {
        foreach (var message in messages)
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
                if ((SessionWait.Text(part["imageMeta"]?["imageId"]) ?? SessionWait.Text(part["inlineDataRef"]?["imageId"])) == id) return part;
        return null;
    }
}
