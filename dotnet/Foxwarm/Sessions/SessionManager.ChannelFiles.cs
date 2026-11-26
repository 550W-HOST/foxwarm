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
        var owner = id is null ? null : await GetExistingAsync(id, token);
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
        if (!Capabilities.MasterNode)
            return await UnkeptChannelFileAsync(bytes, filename, mime, caption, image, token);
        // Inbound channel files are stored on master under the receiving Agent's directory.
        var agent = owner?.Agent ?? "main";
        var segment = Regex.Replace(platform.Trim(), "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
        if (segment.Length == 0)
            segment = "file";
        var name = ChannelFileNames.StorageName(
            filename,
            mime,
            DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ"),
            Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4))
        );
        var relative = ".temp/channel-files/" + segment + "/" + name;
        var path = Path.Combine(AgentDirectory(agent), relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!await FileToolWrite.WriteBytesAtomic(path, bytes, false, () => { }, token))
            throw new IOException("Inbound file already exists.");
        var descriptor = ChannelFileNames.Descriptor(filename, path, mime, "master", image);
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
            parts.Add(await InlineChannelImageAsync(bytes, mime, token));
        return parts;
    }

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
