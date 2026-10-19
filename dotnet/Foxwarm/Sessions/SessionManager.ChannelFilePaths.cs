using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal string InboundChannelNode(SessionOwner owner) =>
        !AgentIsolated(owner.Agent) ? "master"
        : CurrentNode(owner) is { } node && node != "master" ? node
        : BoundNode(owner.Agent) ?? "master";

    // The resolved ingress owner, not a later conversation binding, owns the saved attachment.
    internal async Task<IReadOnlyList<JsonObject>> SaveInboundChannelFileFromPathAsync(
        SessionOwner owner, string platform, string source, long size, string filename,
        string mime, bool image, CancellationToken token)
    {
        using var admission = BeginOwnerMutation(owner);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session owner is no longer current.");
        if (new FileInfo(source).Length != size)
            throw new IOException("Inbound spool size changed.");
        if (InboundChannelNode(owner) != "master")
        {
            if (size > 10 * 1024 * 1024)
                throw new InvalidDataException("Attachment exceeds the Node transfer limit.");
            return await SaveInboundChannelFileCoreAsync(platform, owner,
                await File.ReadAllBytesAsync(source, token), filename, mime, "", token, image);
        }
        var segment = Regex.Replace(platform.Trim(), "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
        var name = ChannelFileNames.StorageName(filename, mime,
            DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ"),
            Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(4)));
        var path = Path.Combine(AgentDirectory(owner.Agent), ".temp", "channel-files",
            segment.Length == 0 ? "file" : segment, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!await FileToolCore.CopyPathAtomic(source, path, false, () => { }, token))
            throw new IOException("Inbound file already exists.");
        var parts = new List<JsonObject>
        {
            new() { ["text"] = ChannelFileNames.Descriptor(filename, path, mime, "master", image) }
        };
        if (image)
        {
            // Only a byte-probed raster under the safe inline cap reaches the blob owner.
            if (size > 20 * 1024 * 1024)
                throw new InvalidDataException("Image exceeds the inline limit.");
            var bytes = await File.ReadAllBytesAsync(source, token);
            var imageId = "image_" + Guid.NewGuid();
            var reference = await Images.PutAsync(bytes, mime, imageId, token);
            parts.Add(new JsonObject
            {
                ["inlineDataRef"] = reference,
                ["imageMeta"] = new JsonObject
                {
                    ["imageId"] = imageId, ["mimeType"] = mime, ["sizeBytes"] = bytes.Length,
                    ["width"] = reference["width"]?.DeepClone(),
                    ["height"] = reference["height"]?.DeepClone(),
                    ["sha256"] = reference["sha256"]?.DeepClone()
                }
            });
        }
        return parts;
    }
}
