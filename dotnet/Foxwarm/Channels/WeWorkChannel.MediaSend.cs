using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel
{
    private const int ChunkBytes = 512 * 1024;
    private const long MaxMediaBytes = ChunkBytes * 100L;

    private static string AckString(JsonObject ack, string field, string command) =>
        Nonempty(Text(ack["body"]?[field])) ? Text(ack["body"]?[field])
            : throw new IOException($"WeWork AIBot command {command} returned a malformed ack without {field}");

    private async Task<string> UploadSocketMediaAsync(ChannelFile file, CancellationToken token)
    {
        // Open the actual file once; do not infer size or regular-file status from caller metadata.
        if (!Foxwarm.Tools.WorkspaceTools.RegularFile(file.Path))
            throw new IOException("WeWork AIBot media upload requires a regular file");
        await using var input = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, ChunkBytes, FileOptions.Asynchronous);
        if (!Foxwarm.Tools.WorkspaceTools.RegularFileHandle(input, file.Path))
            throw new IOException("WeWork AIBot media upload requires a regular file");
        var size = input.Length;
        if (size > MaxMediaBytes)
            throw new IOException($"WeWork AIBot media exceeds the {MaxMediaBytes}-byte protocol limit");
        var chunks = Math.Max(1, (int)((size + ChunkBytes - 1) / ChunkBytes));
        using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        var buffer = new byte[ChunkBytes];
        long position = 0;
        while (position < size)
        {
            var length = (int)Math.Min(buffer.Length, size - position);
            if (await input.ReadAsync(buffer.AsMemory(0, length), token) != length)
                throw new IOException($"WeWork AIBot media changed or ended while hashing at byte {position}");
            md5.AppendData(buffer, 0, length);
            position += length;
        }
        var init = await SendCommandAsync("aibot_upload_media_init", new JsonObject
        {
            ["type"] = file.IsImage ? "image" : "file", ["filename"] = file.Name,
            ["total_size"] = size, ["total_chunks"] = chunks, ["md5"] = Convert.ToHexStringLower(md5.GetHashAndReset()),
        }, null, token);
        var uploadId = AckString(init, "upload_id", "aibot_upload_media_init");
        for (var index = 0; index < chunks; index++)
        {
            input.Position = (long)index * ChunkBytes;
            var length = (int)Math.Min(ChunkBytes, size - input.Position);
            if (length > 0 && await input.ReadAsync(buffer.AsMemory(0, length), token) != length)
                throw new IOException($"WeWork AIBot media changed or ended while reading chunk {index}");
            await SendCommandAsync("aibot_upload_media_chunk", new JsonObject
            {
                ["upload_id"] = uploadId, ["chunk_index"] = index,
                ["base64_data"] = Convert.ToBase64String(buffer, 0, Math.Max(0, length)),
            }, null, token);
        }
        var finish = await SendCommandAsync("aibot_upload_media_finish", new JsonObject { ["upload_id"] = uploadId }, null, token);
        return AckString(finish, "media_id", "aibot_upload_media_finish");
    }

    private async Task<string> UploadLegacyAsync(string url, ChannelFile file, CancellationToken token)
    {
        var uri = new Uri(url);
        var key = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(uri.Query)["key"].FirstOrDefault();
        if (!Nonempty(key))
            throw new InvalidDataException("WeWork webhook URL is missing key, cannot upload media");
        var uploadUrl = uri.GetLeftPart(UriPartial.Authority) + "/cgi-bin/webhook/upload_media?key=" + Uri.EscapeDataString(key!) + "&type=file";
        var bytes = await File.ReadAllBytesAsync(file.Path, token);
        var boundary = "foxwarm-" + Guid.NewGuid().ToString("N");
        // Source supplies the actual filename/MIME in this legacy multipart frame.
        var header = Encoding.UTF8.GetBytes($"--{boundary}\r\nContent-Disposition: form-data; name=\"media\"; filename=\"{file.Name}\"\r\nContent-Type: {file.MimeType}\r\n\r\n");
        var footer = Encoding.UTF8.GetBytes($"\r\n--{boundary}--\r\n");
        var content = new ByteArrayContent([.. header, .. bytes, .. footer]);
        content.Headers.ContentType = MediaTypeHeaderValue.Parse("multipart/form-data; boundary=" + boundary);
        var result = await PostAsync(uploadUrl, content, 20000, token);
        if (!Zero(result["errcode"]) || !Nonempty(Text(result["media_id"])))
            throw new IOException($"WeWork media upload failed: {Text(result["errmsg"])} (code: {result["errcode"]})");
        return Text(result["media_id"]);
    }

    internal async Task SendFileAsync(string conversation, ChannelFile file, string? caption, ChannelSendOptions options, CancellationToken token)
    {
        var explicitWebhook = Nonempty(options.WebhookUrl) ? options.WebhookUrl : null;
        if (explicitWebhook is null && WebSocketEnabled)
        {
            var mediaId = await UploadSocketMediaAsync(file, token);
            if (Nonempty(caption))
                await SendProactiveAsync(conversation, Markdown(caption!), options, token);
            var type = file.IsImage ? "image" : "file";
            await SendProactiveAsync(conversation, new JsonObject { ["msgtype"] = type, [type] = new JsonObject { ["media_id"] = mediaId } }, options, token);
            return;
        }
        var url = explicitWebhook ?? webhook;
        if (!Nonempty(url))
            throw new InvalidOperationException("WeWork webhookUrl is not configured for proactive sendFile");
        var chat = EffectiveChat(conversation, options);
        if (Nonempty(caption))
            await SendTextAsync(conversation, caption!, options with { MessageType = "text", WebhookUrl = url, ChatId = chat }, token);
        JsonObject payload;
        if (file.IsImage)
        {
            var bytes = await File.ReadAllBytesAsync(file.Path, token);
            payload = new JsonObject
            {
                ["msgtype"] = "image", ["image"] = new JsonObject
                {
                    ["base64"] = Convert.ToBase64String(bytes), ["md5"] = Convert.ToHexStringLower(MD5.HashData(bytes)),
                },
            };
        }
        else
            payload = new JsonObject { ["msgtype"] = "file", ["file"] = new JsonObject { ["media_id"] = await UploadLegacyAsync(url, file, token) } };
        if (chat is not null)
            payload["chatid"] = chat;
        await PostWebhookAsync(url, payload, token);
    }
}
