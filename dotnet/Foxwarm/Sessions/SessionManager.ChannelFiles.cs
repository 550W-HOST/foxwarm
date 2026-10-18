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
        using var admission = owner is null ? null : BeginOwnerMutation(owner);
        var agent = owner?.Agent ?? "main";
        // External Source saves differ from WebUI staging: only effectively isolated Sessions select a Node.
        var isolated = owner is not null && AgentIsolated(agent);
        var node =
            isolated && CurrentNode(owner!) is { } current && current != "master" ? current
            : isolated ? BoundNode(agent) ?? "master"
            : "master";
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
        string path;
        if (node != "master")
        {
            var result = await Nodes.WriteFileAsync(
                node,
                relative,
                bytes,
                false,
                owner!,
                true,
                token
            );
            path =
                SessionWait.Text(result["absolutePath"])
                ?? SessionWait.Text(result["filePath"])
                ?? relative;
        }
        else
        {
            path = Path.Combine(AgentDirectory(agent), relative);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (!await FileToolCore.WriteBytesAtomic(path, bytes, false, () => { }, token))
                throw new IOException("Inbound file already exists.");
        }
        var descriptor = ChannelFileNames.Descriptor(filename, path, mime, node, isImage);
        var parts = new List<JsonObject>
        {
            new()
            {
                ["text"] = string.IsNullOrEmpty(caption)
                    ? descriptor
                    : caption + "\n\n" + descriptor,
            },
        };
        if (isImage ?? mime.StartsWith("image/", StringComparison.Ordinal))
        {
            var imageId = "image_" + Guid.NewGuid();
            var reference = await Images.PutAsync(bytes, mime, imageId, token);
            parts.Add(
                new JsonObject
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
                }
            );
        }
        return parts;
    }
}
