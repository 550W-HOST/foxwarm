using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // The one running WebUI adapter provides path readiness, not a target notification.
    private Action<string, string, string?>? webUiFileDelivery;

    internal void RegisterWebUiFileDelivery(Action<string, string, string?>? handler) =>
        Volatile.Write(ref webUiFileDelivery, handler);

    internal void AttachWebUi(string requested, SessionOwner? owner = null)
    {
        using var admission = owner is null
            ? BeginMutation([requested])
            : BeginOwnerMutation(owner);
        var id = owner?.Id ?? requested;
        if (Catalog.Get(id) is null)
            throw new InvalidOperationException("WebUI ingress Session is no longer available.");
        deletionChannels.Attach("webui:" + id, id);
    }

    internal async Task<JsonObject> SendFileAsync(
        SessionOwner owner,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token,
        string? selectedNode = null,
        string? selectedCwd = null
    )
    {
        ToolRegistry.Keys(
            args,
            ["channelTargetId", "sessionId", "filePath", "node", "caption"]
        );
        var node = ToolRegistry.TargetNode(
            ToolRegistry.Text(args, "node"),
            selectedNode ?? CurrentNode(owner)
        );
        // The Agent folder endpoint is copy's alone.
        if (node == AgentStorePaths.Endpoint)
            Foxwarm.Nodes.NodeProviderRegistry.ValidateId(node);
        var raw = SessionGoal.Trim(ToolRegistry.Text(args, "filePath") ?? "");
        if (raw.Length == 0)
            throw new InvalidDataException("send_file requires filePath.");
        var currentNode = selectedNode ?? CurrentNode(owner);
        var sessionCwd =
            node != currentNode ? null
            : selectedNode is null ? ExecutionPlacement(owner).Cwd
            : selectedCwd;
        var requested = SessionGoal.Trim(ToolRegistry.Text(args, "sessionId") ?? "");
        var direct = Foxwarm.Channels.ChannelRegistry.FileDeliveryTarget(args);
        if (requested.Length > 0 && direct.Length > 0)
            throw new InvalidDataException(
                "At most one of sessionId or channelTargetId may be specified."
            );
        var caption = SessionGoal.Trim(ToolRegistry.Text(args, "caption") ?? "");
        token.ThrowIfCancellationRequested();
        using var admission = BeginOwnerMutation(owner);
        var bindings = deletionChannels.ReadForDelivery()["channels"]!.AsObject();
        var target =
            direct.Length > 0 ? null : FileSession(requested.Length > 0 ? requested : owner.Id);
        var destinations =
            direct.Length > 0
                ? [direct]
                : bindings
                    .Where(pair => SessionCatalog.Text(pair.Value?["sessionId"]) == target)
                    .Select(pair => pair.Key)
                    .ToArray();
        if (destinations.Length == 0)
            throw new InvalidDataException($"Session `{target}` has no attached channels.");
        string path;
        string name;
        string? mimeType = null;
        if (node == "master")
        {
            RequireMasterNode();
            path = files.Paths.FilePath(raw);
            if (!WorkspaceTools.RegularFile(path))
                throw new InvalidDataException("Not a regular file: " + raw);
            name = Path.GetFileName(path);
        }
        else
        {
            await using var file = await OpenNodeReadAsync(
                owner,
                node,
                raw,
                files,
                token,
                sessionCwd
            );
            mimeType = file.MimeType;
            name = Foxwarm.Nodes.NodeConnectionHub.RemoteFileName(file.Name);
            if (string.IsNullOrWhiteSpace(name) || name is "." or "..")
                throw new InvalidDataException("Node file name is invalid.");
            var directory = Path.Combine(
                AgentDirectory(owner.Agent),
                ".temp",
                "file-delivery",
                Guid.NewGuid().ToString("N")
            );
            Directory.CreateDirectory(directory);
            path = Path.Combine(directory, name);
            try
            {
                await using (
                    var staging = new FileStream(
                        path,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        65536,
                        FileOptions.Asynchronous
                    )
                )
                    await Foxwarm.Nodes.TransferStream.CopyAsync(
                        file.Stream,
                        staging,
                        file.Length,
                        token
                    );
                await WaitForIdentityMutationAsync(owner.Id, token);
                await AuthorizeToolAsync(
                    owner,
                    new("send_file", "builtin", "send_file", args, ExecutionNode: node),
                    IdentityWorkspace(owner),
                    token
                );
            }
            catch
            {
                Directory.Delete(directory, recursive: true);
                throw;
            }
        }
        var artifact = FileDeliveryArtifact.Create(
            target is null ? "channel" : "session",
            target ?? direct,
            name,
            new FileInfo(path).Length,
            path,
            node,
            mimeType
        );
        var delivered = new List<string>();
        var skipped = new JsonArray();
        var failed = new JsonArray();
        foreach (var destination in destinations)
        {
            token.ThrowIfCancellationRequested();
            var colon = destination.IndexOf(':');
            if (colon <= 0 || colon == destination.Length - 1)
                throw new InvalidDataException(
                    "Invalid channelTargetId format. Use <channel-instance-id>:<conversation-id>."
                );
            if (
                direct.Length == 0
                && SessionCatalog.Text(bindings[destination]?["mode"]) == "send-only"
            )
            {
                skipped.Add(DeliveryOutcome(destination, "send-only"));
                continue;
            }
            try
            {
                owner.Entry.RequireIdentityAuthority();
                if (!IsCurrentOwner(owner))
                    throw new InvalidOperationException(
                        "File source Session is no longer current."
                    );
                var conversation = destination[(colon + 1)..];
                if (destination[..colon] == "webui")
                {
                    var bound = SessionCatalog.Text(bindings[destination]?["sessionId"]);
                    _ = FileSession(bound ?? conversation);
                    var handler =
                        Volatile.Read(ref webUiFileDelivery)
                        ?? throw new InvalidOperationException(
                            "WebUI file delivery is unavailable."
                        );
                    handler(conversation, path, caption.Length > 0 ? caption : null);
                }
                else
                {
                    var channel =
                        ChannelRegistry.Get(destination[..colon])
                        ?? throw new InvalidOperationException(
                            "Channel instance is unavailable: " + destination[..colon]
                        );
                    if (channel.SendFile is null)
                    {
                        if (direct.Length > 0)
                            throw new InvalidOperationException(
                                "Channel does not support file delivery."
                            );
                        skipped.Add(DeliveryOutcome(destination, "no file support"));
                        continue;
                    }
                    var mime = SessionWait.Text(artifact["mimeType"]);
                    await channel.SendFile(
                        conversation,
                        new Foxwarm.Channels.ChannelFile(
                            path,
                            name,
                            mime,
                            mime?.StartsWith("image/", StringComparison.Ordinal) == true
                        ),
                        caption.Length > 0 ? caption : null,
                        token
                    );
                }
                delivered.Add(destination);
            }
            catch (Exception error)
                when (error is not OperationCanceledException || !token.IsCancellationRequested)
            {
                if (direct.Length > 0)
                    throw;
                failed.Add(DeliveryOutcome(destination, error.Message));
            }
        }
        if (delivered.Count == 0)
        {
            var lines = new List<string>
            {
                $"File `{name}` is ready for session `{target ?? direct}`.",
                "Delivered: 0",
            };
            if (skipped.Count > 0)
                lines.Add("Skipped: " + DeliveryOutcomeText(skipped));
            if (failed.Count > 0)
                lines.Add("Failed: " + DeliveryOutcomeText(failed));
            throw new InvalidOperationException(string.Join("\n", lines));
        }
        var result = new JsonObject
        {
            ["fullPath"] = path,
            ["fileDelivery"] = artifact,
            ["delivered"] = new JsonArray(
                delivered.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
            ),
        };
        if (skipped.Count > 0)
            result["skipped"] = skipped;
        if (failed.Count > 0)
            result["failed"] = failed;
        return result;
    }

    private static JsonObject DeliveryOutcome(string channelTargetId, string reason) =>
        new() { ["channelTargetId"] = channelTargetId, ["reason"] = reason };

    private static string DeliveryOutcomeText(JsonArray outcomes) =>
        string.Join(
            ", ",
            outcomes
                .OfType<JsonObject>()
                .Select(item => $"`{SessionWait.Text(item["channelTargetId"])}` ({SessionWait.Text(item["reason"])})")
        );

    private string FileSession(string requested) =>
        SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"])
        ?? throw new InvalidDataException("Session is not available: " + requested);

    internal Func<string, string, Task>? BeforeFileStage { get; set; }

    private async Task FileStageAsync(SessionOwner owner, string stage)
    {
        if (BeforeFileStage is { } before)
            await before(owner.Id, stage);
    }

    internal async Task<JsonObject> ExportImageAsync(
        SessionOwner owner,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token,
        string? selectedNode = null,
        string? selectedCwd = null
    )
    {
        ToolRegistry.Keys(args, ["id", "filePath", "overwrite", "node"]);
        var currentNode = selectedNode ?? CurrentNode(owner);
        var node = ToolRegistry.TargetNode(ToolRegistry.Text(args, "node"), currentNode);
        var sessionCwd =
            node != currentNode ? null
            : selectedNode is null ? ExecutionPlacement(owner).Cwd
            : selectedCwd;
        var id = ToolRegistry.Text(args, "id");
        var raw = ToolRegistry.Text(args, "filePath");
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(raw))
            throw new InvalidDataException("image_write_to_file requires id and filePath.");
        var overwrite = OptionalBool(args, "overwrite") ?? false;
        using var admission = BeginOwnerMutation(owner);
        var match = FindOwnedImage(owner.History().Reverse(), id);
        match ??= FindOwnedImage(
            owner
                .Archive.ReadEffectiveMessagesRange(1, 9007199254740991L)
                .Reverse()
                .Select(row => row.Message),
            id
        );
        if (match is null)
            throw new InvalidDataException($"Image id `{id}` not found in session `{owner.Id}`.");
        var bytes =
            match["inlineDataRef"] is JsonObject reference
                ? await Images.ReadAsync(reference, token)
            : match["inlineData"] is JsonObject inline
                ? Foxwarm.Images.ImageBlobStore.InlineBytes(inline)
            : throw new InvalidDataException("Image original bytes are unavailable.");
        await FileStageAsync(owner, "before-effect");
        // Resolve after image I/O from the current owner, then authorize that exact effect context.
        while (true)
        {
            await WaitForIdentityMutationAsync(owner.Id, token);
            var identity = owner.Id;
            files = IdentityWorkspace(owner);
            await AuthorizeToolAsync(
                owner,
                new(
                    "image_write_to_file",
                    "builtin",
                    "image_write_to_file",
                    args,
                    ExecutionNode: node
                ),
                files,
                token
            );
            if (identity == owner.Id)
                break;
        }
        var path = await WriteNodeFileAsync(
            owner,
            node,
            raw,
            bytes,
            overwrite,
            files,
            token,
            sessionCwd
        );
        try
        {
            await FileStageAsync(owner, "after-write");
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidOperationException
                        or OperationCanceledException
                        or TimeoutException
            )
        {
            var partial = ToolFailure.Result(
                "Image was written; a later step failed. The file was not removed or retried. "
                    + error.Message
            );
            partial["fileWritten"] = true;
            partial["fullPath"] = path;
            return partial;
        }
        return new JsonObject
        {
            ["fullPath"] = path,
            ["note"] =
                $"Image `{id}` written on node `{node}`. You can deliver it with `{CtlCommandText.For("send_file", new JsonObject { ["filePath"] = raw, ["node"] = node })}`.",
        };
    }

    internal async Task<JsonObject> CropImageAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["id", "x", "y", "width", "height"]);
        var id = ToolRegistry.Text(args, "id");
        if (string.IsNullOrWhiteSpace(id))
            throw new InvalidDataException("image_crop requires id.");
        int Number(string key)
        {
            var value = SessionWait.Number(args[key]);
            if (
                value is null
                || value != Math.Truncate(value.Value)
                || value < int.MinValue
                || value > int.MaxValue
            )
                throw new InvalidDataException(
                    "image_crop requires integer x, y, width, and height values."
                );
            return (int)value.Value;
        }
        var x = Number("x");
        var y = Number("y");
        var width = Number("width");
        var height = Number("height");
        if (x < 0 || y < 0 || width <= 0 || height <= 0)
            throw new InvalidDataException(
                "image_crop requires x >= 0, y >= 0, width > 0, and height > 0."
            );
        using var admission = BeginOwnerMutation(owner);
        var match =
            FindOwnedImage(owner.History().Reverse(), id)
            ?? FindOwnedImage(
                owner
                    .Archive.ReadEffectiveMessagesRange(1, 9007199254740991L)
                    .Reverse()
                    .Select(row => row.Message),
                id
            );
        if (match is null)
            throw new InvalidDataException($"Image id `{id}` not found in session `{owner.Id}`.");
        var bytes =
            match["inlineDataRef"] is JsonObject reference
                ? await Images.ReadAsync(reference, token)
            : match["inlineData"] is JsonObject inline
                ? Foxwarm.Images.ImageBlobStore.InlineBytes(inline)
            : throw new InvalidDataException("Image original bytes are unavailable.");
        var mime = Foxwarm.Images.ImageBlobStore.Mime(
            match["inlineDataRef"] as JsonObject
                ?? match["inlineData"] as JsonObject
                ?? new JsonObject()
        );
        Foxwarm.Images.RasterCodec.Variant cropped;
        try { cropped = Foxwarm.Images.RasterCrop.Crop(bytes, mime, x, y, width, height); }
        catch (Foxwarm.Images.RasterCrop.Outside bounds) { throw bounds.ForRectangle(x, y, width, height); }
        var outputBytes = cropped.Bytes;
        var outputMime = cropped.MimeType;
        var output =
            mime == "image/gif"
                ? $"[Cropped first frame from {id} as PNG; animation is not preserved]"
                : $"[Cropped image from {id}]";
        return new JsonObject
        {
            ["output"] = output,
            ["sourceImageId"] = id,
            ["crop"] = new JsonObject
            {
                ["x"] = x,
                ["y"] = y,
                ["width"] = width,
                ["height"] = height,
            },
            ["mimeType"] = outputMime,
            ["sizeBytes"] = outputBytes.Length,
            ["inlineData"] = new JsonObject
            {
                ["mimeType"] = outputMime,
                ["data"] = Convert.ToBase64String(outputBytes),
            },
        };
    }

    // Whether a stored image blob is referenced in the Session's own history (live context or
    // archive), as image tools find a Session's images.
    internal static bool HistoryReferencesImage(SessionOwner owner, string blobId)
    {
        static bool Any(IEnumerable<JsonObject> messages, string blob) =>
            messages.Any(message =>
                (message["parts"] as JsonArray ?? [])
                    .OfType<JsonObject>()
                    .Any(part => SessionWait.Text(part["inlineDataRef"]?["blobId"]) == blob)
            );
        return Any(owner.History(), blobId)
            || Any(
                owner
                    .Archive.ReadEffectiveMessagesRange(1, 9007199254740991L)
                    .Select(row => row.Message),
                blobId
            );
    }

    private static JsonObject? FindOwnedImage(IEnumerable<JsonObject> messages, string id)
    {
        foreach (var message in messages)
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            if (
                (
                    SessionWait.Text(part["imageMeta"]?["imageId"])
                    ?? SessionWait.Text(part["inlineDataRef"]?["imageId"])
                ) == id
            )
                return part;
        return null;
    }
}
