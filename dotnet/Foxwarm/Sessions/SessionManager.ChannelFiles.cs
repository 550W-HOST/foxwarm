using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<IReadOnlyList<JsonObject>> SaveInboundChannelFileAsync(
        string platform,
        string conversation,
        byte[] bytes,
        string filename,
        string mime,
        string caption,
        CancellationToken token,
        bool? isImage = null
    )
    {
        var id = SessionWait.Text(ChannelBinding(platform + ":" + conversation)?["sessionId"]);
        using var use = id is null ? null : await UseExistingAsync(id, token);
        var owner = use?.Owner;
        return await SaveInboundChannelFileCoreAsync(
            platform,
            owner,
            bytes,
            filename,
            mime,
            caption,
            token,
            isImage
        );
    }

    private async Task<IReadOnlyList<JsonObject>> SaveInboundChannelFileCoreAsync(
        string platform,
        SessionOwner? owner,
        byte[] bytes,
        string filename,
        string mime,
        string caption,
        CancellationToken token,
        bool? isImage
    )
    {
        using var admission = owner is null ? null : BeginOwnerMutation(owner);
        var image = isImage ?? Foxwarm.Images.ImageInputPolicy.IsImageInput(mime);
        // Inbound channel files are stored under the receiving Agent's directory: on master, or
        // in the Agent store.
        var agent = owner?.Agent ?? "main";
        var relative = ChannelFileRelativePath(platform, filename, mime);
        string descriptor;
        if (Capabilities.Limits is not null && bytes.LongLength > ReceivedFileLimit)
            return UnkeptStoredFile(filename, mime, caption, bytes.LongLength, OversizedReason(ReceivedFileLimit));
        if (!Capabilities.MasterNode)
        {
            if (AgentStore is null)
                return await UnkeptChannelFileAsync(bytes, filename, mime, caption, image, token);
            string stored;
            try
            {
                stored = await SaveStoredChannelFileAsync(agent, relative, bytes, token);
            }
            catch (AgentStoreQuotaException error)
            {
                return UnkeptStoredFile(filename, mime, caption, bytes.LongLength, error.Message);
            }
            descriptor = ChannelFileNames.Descriptor(filename, stored, mime, AgentStorePaths.Endpoint, image);
        }
        else
        {
            var path = Path.Combine(AgentDirectory(agent), relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (!await FileToolWrite.WriteBytesAtomic(path, bytes, false, () => { }, token))
                throw new IOException("Inbound file already exists.");
            descriptor = ChannelFileNames.Descriptor(filename, path, mime, "master", image);
        }
        var parts = new List<JsonObject>
        {
            new()
            {
                ["text"] = string.IsNullOrEmpty(caption)
                    ? descriptor
                    : caption + "\n\n" + descriptor,
            },
        };
        if (image)
            parts.Add(await SavedChannelImagePartAsync(bytes, mime, token));
        return parts;
    }

    private async Task<JsonObject> SavedChannelImagePartAsync(byte[] bytes, string mime, CancellationToken token)
    {
        try { return await InlineChannelImageAsync(bytes, mime, token); }
        catch (Foxwarm.Limits.TenantLimitException error) when (error.Limit == "blobBytes")
        {
            return new JsonObject { ["text"] = "[Image not attached inline: the storage limit for images is reached.]" };
        }
    }

    internal long ReceivedFileLimit => Math.Min(
        Capabilities.Limits?.UploadBytes ?? Foxwarm.Channels.WebUi.WebUiUploadedFiles.Limit,
        AgentStore?.Limits.FileBytes ?? Foxwarm.Channels.WebUi.WebUiUploadedFiles.Limit
    );

    // `.temp/channel-files/<platform>/<storage name>` of a received file.
    internal static string ChannelFileRelativePath(string platform, string filename, string mime)
    {
        var segment = Regex.Replace(platform.Trim(), "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
        if (segment.Length == 0)
            segment = "file";
        var name = ChannelFileNames.StorageName(
            filename,
            mime,
            DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ"),
            Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4))
        );
        return ".temp/channel-files/" + segment + "/" + name;
    }

    // A received file in the Agent store, written once; the folder path the model reads it by.
    internal async Task<string> SaveStoredChannelFileAsync(string agent, string relative, byte[] bytes, CancellationToken token)
    {
        try
        {
            await AgentStore!.WriteAsync(agent, relative, bytes, 0, token);
        }
        catch (AgentFileConflictException)
        {
            throw new IOException("Inbound file already exists.");
        }
        return AgentFolderPaths.Variable + "/" + relative;
    }

    // A received file the Agent store can't keep (over its per-file limit, or the store is
    // full): named, not kept, with the reason.
    internal static IReadOnlyList<JsonObject> UnkeptStoredFile(string filename, string mime, string caption, long? size, string reason, long? limit = null)
    {
        var length = size is { } known ? $"{known} bytes" : $"more than {limit} bytes";
        var notice = $"[Received file not kept: \"{filename}\" ({mime}, {length}). {reason}]";
        return [new JsonObject { ["text"] = caption.Length > 0 ? caption + "\n\n" + notice : notice }];
    }

    internal static string OversizedReason(long limit) =>
        $"It is larger than the {Foxwarm.Limits.TenantLimits.Size(limit)} limit for received files.";

    // Without a master Node no tool can read the Agent directory, so a received file is not
    // stored there: an image reaches the model inline only, and any other file is named in the
    // message as not kept, so the loss is visible to the model and through it to the sender.
    internal async Task<IReadOnlyList<JsonObject>> UnkeptChannelFileAsync(
        byte[]? bytes,
        string filename,
        string mime,
        string caption,
        bool image,
        CancellationToken token,
        long? size = null
    )
    {
        var parts = new List<JsonObject>();
        if (image && bytes is not null)
        {
            if (caption.Length > 0)
                parts.Add(new JsonObject { ["text"] = caption });
            parts.Add(await InlineChannelImageAsync(bytes, mime, token));
            return parts;
        }
        var notice =
            $"[Received file not kept: \"{filename}\" ({mime}, {size ?? bytes?.LongLength ?? 0} bytes). This server keeps received images only.]";
        parts.Add(new JsonObject { ["text"] = caption.Length > 0 ? caption + "\n\n" + notice : notice });
        return parts;
    }

    private async Task<JsonObject> InlineChannelImageAsync(
        byte[] bytes,
        string mime,
        CancellationToken token
    )
    {
        var imageId = "image_" + Guid.NewGuid();
        var reference = await Images.PutAsync(bytes, mime, imageId, token);
        return new JsonObject
        {
            ["inlineDataRef"] = reference,
            ["imageMeta"] = new JsonObject
            {
                ["imageId"] = imageId,
                ["mimeType"] = mime,
                ["sizeBytes"] = bytes.Length,
                ["width"] = reference["width"]?.DeepClone(),
                ["height"] = reference["height"]?.DeepClone(),
                ["sha256"] = reference["sha256"]?.DeepClone(),
            },
        };
    }
}
