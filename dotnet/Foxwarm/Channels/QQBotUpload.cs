using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Channels;

internal static class QQBotUpload
{
    internal const long DirectThreshold = 5L * 1024 * 1024;
    internal const long HardCap = 100L * 1024 * 1024;
    private const long Md5TenMillion = 10_002_432;
    private sealed record Part(int Index, Uri Url, long Size);
    private static string Bounded(JsonNode? value, int max, string label) =>
        Foxwarm.Sessions.SessionWait.Text(value)?.Trim() is { Length: > 0 } text && text.Length <= max ? text
        : throw new IOException("QQ Bot upload response has invalid " + label + ".");
    private static int Positive(JsonNode? value, int max, string label) =>
        value is JsonValue scalar && scalar.GetValueKind() == System.Text.Json.JsonValueKind.Number
        && double.TryParse(value.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number)
        && number == Math.Truncate(number) && number > 0 && number <= max ? (int)number
        : throw new IOException("QQ Bot upload response has invalid " + label + ".");
    private static string PathFor(string kind, string id, string suffix) =>
        (kind == "c2c" ? "/v2/users/" : "/v2/groups/") + Uri.EscapeDataString(id) + "/" + suffix;
    private static string Hex(IncrementalHash hash) => Convert.ToHexStringLower(hash.GetHashAndReset());
    internal static async Task<string> UploadAsync(string kind, string id, ChannelFile file,
        JsonObject? config, Func<string, JsonObject, Task<JsonObject>> request,
        HttpClient http, Action requireCurrent, CancellationToken token, TimeSpan? partTimeout = null)
    {
        requireCurrent();
        if (!WorkspaceTools.RegularFile(file.Path) || new FileInfo(file.Path).LinkTarget is not null)
            throw new IOException("QQ Bot file source must be a regular file.");
        await using var input = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read,
            65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (!WorkspaceTools.RegularFileHandle(input, file.Path)) throw new IOException("QQ Bot file source must be a regular file.");
        var size = input.Length;
        if (size <= 0) throw new IOException("QQ Bot cannot upload an empty file.");
        if (size > HardCap) throw new IOException("QQ Bot file exceeds the configured media limit.");
        requireCurrent();
        var imageLimit = QQBotMedia.Limit(config?["imageMaxBytes"], 20L * QQBotMedia.MiB, 20L * QQBotMedia.MiB);
        var fileLimit = QQBotMedia.Limit(config?["fileMaxBytes"], 50L * QQBotMedia.MiB, HardCap);
        var image = size <= imageLimit && QQBotRaster.OfficialImage(file.Path);
        if (!image && size > fileLimit) throw new IOException("QQ Bot file exceeds the configured media limit.");
        var fileType = image ? 1 : 4;
        if (size < DirectThreshold)
        {
            requireCurrent();
            if (input.Length != size) throw new IOException("QQ Bot file changed while it was being read.");
            var data = new byte[size];
            await input.ReadExactlyAsync(data, token);
            requireCurrent();
            var body = new JsonObject
            {
                ["file_type"] = fileType, ["srv_send_msg"] = false,
                ["file_data"] = Convert.ToBase64String(data)
            };
            if (!image) body["file_name"] = QQBotMedia.SafeName(file.Name);
            var response = await request(PathFor(kind, id, "files"), body);
            requireCurrent();
            return Bounded(response["file_info"], 8192, "file_info");
        }
        using var md5 = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        using var sha1 = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
        using var md5Prefix = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
        var bytes = new byte[65536];
        long position = 0;
        while (position < size)
        {
            var count = (int)Math.Min(bytes.Length, size - position);
            await input.ReadExactlyAsync(bytes.AsMemory(0, count), token);
            md5.AppendData(bytes, 0, count); sha1.AppendData(bytes, 0, count);
            if (position < Md5TenMillion) md5Prefix.AppendData(bytes, 0, (int)Math.Min(count, Md5TenMillion - position));
            position += count;
        }
        requireCurrent();
        var prepared = await request(PathFor(kind, id, "upload_prepare"), new JsonObject
        {
            ["file_type"] = fileType, ["file_size"] = size, ["file_name"] = QQBotMedia.SafeName(file.Name),
            ["md5"] = Hex(md5), ["sha1"] = Hex(sha1), ["md5_10m"] = Hex(md5Prefix)
        });
        var upload = Bounded(prepared["upload_id"], 256, "upload_id");
        var block = Positive(prepared["block_size"], (int)HardCap, "block_size");
        if (prepared["parts"] is not JsonArray parts || parts.Count == 0 || parts.Count > 4096 || parts.Count != (size + block - 1) / block)
            throw new IOException("QQ Bot upload_prepare returned an incomplete part list.");
        // Validate the whole prepare response before beginning any part PUT.
        var parsed = new List<Part>();
        for (var index = 0; index < parts.Count; index++)
        {
            if (parts[index] is not JsonObject raw || Positive(raw["index"], 4096, "part index") != index + 1)
                throw new IOException("QQ Bot upload_prepare returned out-of-order parts.");
            var partSize = raw["block_size"] is null ? block : Positive(raw["block_size"], (int)HardCap, "part block_size");
            if (partSize > block) throw new IOException("QQ Bot upload response has an oversized part range.");
            var url = QQBotMedia.ValidateUrl(Bounded(raw["presigned_url"] ?? raw["url"], 8192, "part URL"), false);
            parsed.Add(new(index + 1, url, partSize));
        }
        foreach (var part in parsed)
        {
            requireCurrent();
            var offset = (part.Index - 1L) * block;
            var length = Math.Min(part.Size, size - offset);
            if (length <= 0 || offset + length > size) throw new IOException("QQ Bot upload response has an invalid part range.");
            input.Position = offset;
            long left = length;
            while (left > 0)
            {
                var count = (int)Math.Min(left, bytes.Length);
                await input.ReadExactlyAsync(bytes.AsMemory(0, count), token);
                md5.AppendData(bytes, 0, count); left -= count;
            }
            var hash = Hex(md5);
            requireCurrent();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(partTimeout ?? TimeSpan.FromSeconds(20));
            input.Position = offset;
            using var put = new HttpRequestMessage(HttpMethod.Put, part.Url)
            {
                Content = new PartContent(input, length)
            };
            // No shared bot headers or cookies and no redirect/retry on presigned hosts.
            try
            {
                requireCurrent();
                using var response = await http.SendAsync(put, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (!response.IsSuccessStatusCode) throw new IOException($"QQ Bot media part upload failed ({(int)response.StatusCode}).");
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new IOException("QQ Bot media part upload timed out."); }
            catch (HttpRequestException) { throw new IOException("QQ Bot media part upload failed."); }
            requireCurrent();
            await request(PathFor(kind, id, "upload_part_finish"), new JsonObject
            {
                ["upload_id"] = upload, ["part_index"] = part.Index, ["block_size"] = length, ["md5"] = hash
            });
        }
        requireCurrent();
        var completed = await request(PathFor(kind, id, "files"), new JsonObject { ["upload_id"] = upload });
        requireCurrent();
        return Bounded(completed["file_info"], 8192, "file_info");
    }
    // Content owns only its byte range, not the caller's file handle. Large sends never buffer a part.
    private sealed class PartContent(FileStream input, long length) : HttpContent
    {
        protected override bool TryComputeLength(out long result) { result = length; return true; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeToStreamAsync(stream, context, CancellationToken.None);
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken token)
        {
            var buffer = new byte[65536];
            var remaining = length;
            while (remaining > 0)
            {
                var count = (int)Math.Min(buffer.Length, remaining);
                await input.ReadExactlyAsync(buffer.AsMemory(0, count), token);
                await stream.WriteAsync(buffer.AsMemory(0, count), token);
                remaining -= count;
            }
        }
    }
}
