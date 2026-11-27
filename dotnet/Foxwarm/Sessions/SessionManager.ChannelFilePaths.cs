using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // The resolved ingress owner, not a later conversation binding, owns the saved attachment.
    internal async Task<IReadOnlyList<JsonObject>> SaveInboundChannelFileFromPathAsync(
        SessionOwner owner,
        string platform,
        string source,
        long size,
        string filename,
        string mime,
        bool image,
        CancellationToken token
    )
    {
        using var admission = BeginOwnerMutation(owner);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException("Attachment Session owner is no longer current.");
        if (new FileInfo(source).Length != size)
            throw new IOException("Inbound spool size changed.");
        if (Capabilities.Limits is not null && size > ReceivedFileLimit)
            return UnkeptStoredFile(filename, mime, "", size, OversizedReason(ReceivedFileLimit));
        if (!Capabilities.MasterNode)
        {
            if (image && size > 20 * 1024 * 1024)
                throw new InvalidDataException("Image exceeds the inline limit.");
            if (AgentStore is null)
                return await UnkeptChannelFileAsync(image ? await File.ReadAllBytesAsync(source, token) : null, filename, mime, "", image, token, size);
            var bytes = await File.ReadAllBytesAsync(source, token);
            string stored;
            try
            {
                stored = await SaveStoredChannelFileAsync(owner.Agent, ChannelFileRelativePath(platform, filename, mime), bytes, token);
            }
            catch (AgentStoreQuotaException error)
            {
                return UnkeptStoredFile(filename, mime, "", size, error.Message);
            }
            var saved = new List<JsonObject> { new() { ["text"] = ChannelFileNames.Descriptor(filename, stored, mime, AgentStorePaths.Endpoint, image) } };
            if (image)
                saved.Add(await SavedChannelImagePartAsync(bytes, mime, token));
            return saved;
        }
        var path = Path.Combine(AgentDirectory(owner.Agent), ChannelFileRelativePath(platform, filename, mime));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!await FileToolWrite.CopyPathAtomic(source, path, false, () => { }, token))
            throw new IOException("Inbound file already exists.");
        var parts = new List<JsonObject>
        {
            new() { ["text"] = ChannelFileNames.Descriptor(filename, path, mime, "master", image) },
        };
        if (image)
        {
            // Only a byte-probed raster under the safe inline cap reaches the blob owner.
            if (size > 20 * 1024 * 1024)
                throw new InvalidDataException("Image exceeds the inline limit.");
            parts.Add(await SavedChannelImagePartAsync(await File.ReadAllBytesAsync(source, token), mime, token));
        }
        return parts;
    }
}
