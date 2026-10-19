using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class QQBotMedia(SessionManager sessions, HttpClient http, JsonObject? config,
    ChannelTransportDependencies? dependencies)
{
    internal const int MiB = 1024 * 1024;
    internal static long Limit(JsonNode? value, long fallback, long hard)
    {
        return double.TryParse(value?.ToString(), out var number) && double.IsFinite(number) && number > 0
            ? (long)Math.Min(Math.Floor(number), hard) : fallback;
    }
    private long ImageLimit => Limit(config?["imageMaxBytes"], 20L * MiB, 20L * MiB);
    private long FileLimit => Limit(config?["fileMaxBytes"], 50L * MiB, 200L * MiB);
    private long TotalLimit => Limit(config?["maxTotalBytes"], 200L * MiB, 200L * MiB);
    private int CountLimit => (int)Math.Clamp(double.TryParse(config?["maxAttachments"]?.ToString(), out var count) && double.IsFinite(count) ? Math.Truncate(count) : 8, 1, 16);
    private sealed record Attachment(string Kind, string Name, string Mime, long? Size,
        string? Url, string? Wav, string? Asr);
    private sealed class MediaError(string message) : IOException(message);
    private static MediaError Invalid() => new("media metadata or bytes were invalid");
    private static MediaError TooLarge() => new("media download exceeded the configured size limit");
    private static MediaError Storage() => new("media storage failed");
    private static string Clean(JsonNode? node, int max)
    {
        var text = SessionWait.Text(node) ?? "";
        text = Regex.Replace(text, "[\\x00-\\x1f\\x7f]", " ").Trim();
        return text[..Math.Min(max, text.Length)];
    }
    internal static string SafeName(string value, int max = 160)
    {
        var name = Path.GetFileName(value.Replace('\\', '/'));
        name = Regex.Replace(name, "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
        return name.Length == 0 ? "qqbot-file" : name[..Math.Min(max, name.Length)];
    }
    private static Attachment? Normalize(JsonNode? raw, int index)
    {
        if (raw is not JsonObject value) return null;
        var mime = Clean(value["content_type"] ?? value["mimeType"], 128).ToLowerInvariant();
        if (mime is "" or "file" or "voice") mime = "application/octet-stream";
        var voice = (value["file_type"] ?? value["fileType"])?.ToString() == "3"
            || Clean(value["content_type"] ?? value["mimeType"] ?? value["type"], 128).ToLowerInvariant() == "voice"
            || value["voice_wav_url"] is not null || value["voiceWavUrl"] is not null;
        var wav = voice ? Clean(value["voice_wav_url"] ?? value["voiceWavUrl"], 8192) : "";
        if (voice && mime == "application/octet-stream" && wav.Length > 0) mime = "audio/wav";
        var rawName = Path.GetFileName(Clean(value["filename"] ?? value["fileName"], 160).Replace('\\', '/'));
        var ext = Path.GetExtension(rawName);
        ext = ext[..Math.Min(16, ext.Length)];
        var stem = ext.Length > 0 ? rawName[..^ext.Length] : rawName;
        stem = Regex.Replace(stem, "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
        stem = stem[..Math.Min(96, stem.Length)];
        var extension = mime switch
        {
            "image/jpeg" => ".jpg", "image/png" => ".png", "image/gif" => ".gif", "image/webp" => ".webp",
            _ => Regex.IsMatch(ext, @"^\.[a-zA-Z0-9]{1,15}$") ? ext : ""
        };
        var name = (stem.Length == 0 ? "qqbot-attachment-" + (index + 1) : stem) + extension;
        var sizeRaw = value["size"] ?? value["sizeBytes"];
        long? size = long.TryParse(sizeRaw?.ToString(), out var declared) && declared is >= 0 and <= 9007199254740991 ? declared : null;
        var kind = value["attachments"] is not null || value["children"] is not null ? "unsupported"
            : mime.StartsWith("image/", StringComparison.Ordinal) ? "image" : "file";
        return new(kind, name, mime, size, Clean(value["url"], 8192), wav,
            voice ? Clean(value["asr_refer_text"] ?? value["asrReferText"], 512) : null);
    }
    private static string SizeText(long? size) => size is null ? "unknown size" : size >= MiB
        ? (size.Value / (double)MiB).ToString(size % MiB == 0 ? "0" : "0.0", System.Globalization.CultureInfo.InvariantCulture) + " MiB"
        : size + " bytes";
    private static string Label(Attachment attachment) => attachment.Kind == "unsupported"
        ? $"[QQ unsupported attachment deferred: {attachment.Name}; MIME: {attachment.Mime}; size: {SizeText(attachment.Size)}; reason: nested QQ media is deferred]"
        : $"[QQ {attachment.Kind} attachment: {attachment.Name}; MIME: {attachment.Mime}; size: {SizeText(attachment.Size)}{(string.IsNullOrEmpty(attachment.Asr) ? "" : "; ASR reference: " + attachment.Asr)}]";
    private static JsonObject Part(string text) => new() { ["text"] = text };
    private static string Malformed(int index) => $"[QQ attachment {index + 1}: malformed attachment metadata]";
    internal IReadOnlyList<JsonObject> Preview(string content, JsonArray attachments)
    {
        var parts = new List<JsonObject>();
        if (!string.IsNullOrWhiteSpace(content)) parts.Add(Part(content));
        for (var index = 0; index < Math.Min(attachments.Count, CountLimit); index++)
            parts.Add(Part(Normalize(attachments[index], index) is { } item ? Label(item) : Malformed(index)));
        Omitted(parts, attachments.Count);
        return parts;
    }
    private void Omitted(List<JsonObject> parts, int count)
    {
        if (count > CountLimit) parts.Add(Part($"[QQ media: {count - CountLimit} additional attachments omitted by the inbound bound]"));
        if (parts.Count == 0) parts.Add(Part("[QQ message contained no readable text or media]"));
    }
    internal static Uri ValidateUrl(string? value, bool asset)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 8192 || !Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || uri.UserInfo.Length > 0 || uri.Port != 443) throw Invalid();
        if (asset)
        {
            var host = uri.IdnHost.ToLowerInvariant().TrimEnd('.');
            string[] suffixes = ["qpic.cn", "qq.com", "weiyun.com", "qq.com.cn", "ugcimg.cn", "myqcloud.com", "tencentcos.cn", "tencentcos.com"];
            if (!suffixes.Any(suffix => host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal))) throw Invalid();
        }
        return uri;
    }
    private static string? SelectedUrl(Attachment attachment)
    {
        try { if (!string.IsNullOrEmpty(attachment.Wav)) { ValidateUrl(attachment.Wav, true); return attachment.Wav; } }
        catch (MediaError) { }
        return attachment.Url;
    }
    private TimeSpan Timeout => dependencies?.QQBotMediaTimeout ?? TimeSpan.FromSeconds(15);
    private async Task<long> DownloadAsync(string? url, string path, long max)
    {
        for (var hop = 0; hop <= 3; hop++)
        {
            var uri = ValidateUrl(url, true);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.TryAddWithoutValidation("accept", "*/*");
            using var timeout = new CancellationTokenSource(Timeout);
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308)
                {
                    if (hop == 3 || response.Headers.Location is null) throw Invalid();
                    url = new Uri(uri, response.Headers.Location).ToString();
                    continue;
                }
                if (!response.IsSuccessStatusCode) throw new MediaError("media download failed");
                if (response.Content.Headers.ContentLength > max) throw TooLarge();
                // Match Source's separate bounded body phase after response headers.
                timeout.CancelAfter(Timeout);
                await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
                FileStream file;
                try { file = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous); }
                catch { throw Storage(); }
                await using (file)
                {
                    var bytes = new byte[65536];
                    long total = 0;
                    int count;
                    while ((count = await input.ReadAsync(bytes, timeout.Token)) != 0)
                    {
                        if (total + count > max) throw TooLarge();
                        try { await file.WriteAsync(bytes.AsMemory(0, count), timeout.Token); }
                        catch (OperationCanceledException) { throw; }
                        catch { throw Storage(); }
                        total += count;
                    }
                    return total;
                }
            }
            catch (OperationCanceledException) when (timeout.IsCancellationRequested) { throw new MediaError("media download timed out"); }
            catch (MediaError) { throw; }
            catch { throw new MediaError("media download failed"); }
        }
        throw Invalid();
    }
    internal async Task<IReadOnlyList<JsonObject>> MaterializeAsync(string content, JsonArray attachments, SessionOwner owner)
    {
        var parts = new List<JsonObject>();
        if (!string.IsNullOrWhiteSpace(content)) parts.Add(Part(content));
        bool main;
        try
        {
            using var admission = sessions.BeginFileIngress(owner);
            main = sessions.InboundChannelNode(owner) == "master";
        }
        catch { return Preview(content, attachments).Select(part => Part(SessionWait.Text(part["text"]) + "\n[QQ media unavailable: media storage failed]")).ToArray(); }
        long total = 0;
        var totalReached = false;
        for (var index = 0; index < Math.Min(attachments.Count, CountLimit); index++)
        {
            var attachment = Normalize(attachments[index], index);
            if (attachment is null) { parts.Add(Part(Malformed(index))); continue; }
            var limit = attachment.Kind == "image" ? Math.Max(FileLimit, ImageLimit) : FileLimit;
            if (!main) limit = Math.Min(limit, 10L * MiB);
            var remaining = TotalLimit - total;
            var fetchLimit = Math.Min(limit, remaining);
            var downloaded = false;
            string? directory = null;
            try
            {
                if (attachment.Kind == "unsupported") throw new MediaError("nested QQ media is deferred");
                if (attachment.Size > limit)
                {
                    totalReached |= attachment.Size > TotalLimit;
                    throw TooLarge();
                }
                if (totalReached || total >= TotalLimit) throw TooLarge();
                var url = SelectedUrl(attachment);
                ValidateUrl(url, true);
                try { directory = Directory.CreateTempSubdirectory("foxwarm-qqbot-media-").FullName; }
                catch { throw Storage(); }
                var spool = Path.Combine(directory, "attachment.bin");
                var size = await DownloadAsync(url, spool, fetchLimit);
                total += size; downloaded = true;
                var raster = size <= ImageLimit ? QQBotRaster.Probe(spool) : null;
                if (raster is null && size > FileLimit) throw TooLarge();
                IReadOnlyList<JsonObject> saved;
                try
                {
                    saved = await sessions.SaveInboundChannelFileFromPathAsync(owner, "qqbot", spool, size,
                        attachment.Name, raster ?? attachment.Mime, raster is not null, CancellationToken.None);
                }
                catch { throw Storage(); }
                if (raster is null)
                {
                    var note = attachment.Kind == "image"
                        ? $"\n[QQ image kept as a generic file; inline image limit is {SizeText(ImageLimit)} and no image bytes were sent inline]" : "";
                    if (!string.IsNullOrEmpty(attachment.Asr)) note += "\n[QQ voice ASR reference: " + attachment.Asr + "]";
                    saved[0]["text"] = SessionWait.Text(saved[0]["text"]) + note;
                }
                parts.AddRange(saved);
            }
            catch (Exception error)
            {
                var safe = error is MediaError ? error.Message : "media download failed";
                if (safe == "media download exceeded the configured size limit" && !downloaded && fetchLimit == remaining) totalReached = true;
                parts.Add(Part(Label(attachment) + "\n[QQ media unavailable: " + safe + "]"));
            }
            finally
            {
                if (directory is not null) try { Directory.Delete(directory, true); } catch { }
            }
        }
        Omitted(parts, attachments.Count);
        return parts;
    }
}
