using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel
{
    private async Task<byte[]> DownloadAsync(
        string replyWebhook,
        string directUrl,
        string mediaId,
        bool encrypted,
        string? aeskey = null
    )
    {
        var url = directUrl;
        if (url.Length == 0 && mediaId.Length > 0)
        {
            var webhookUri = new Uri(replyWebhook);
            var key = Microsoft
                .AspNetCore.WebUtilities.QueryHelpers.ParseQuery(webhookUri.Query)["key"]
                .FirstOrDefault();
            if (!Nonempty(key))
                throw new InvalidDataException(
                    "WeWork webhook URL is missing key, cannot download media by media_id"
                );
            url =
                webhookUri.GetLeftPart(UriPartial.Authority)
                + "/cgi-bin/webhook/get_media?key="
                + Uri.EscapeDataString(key!)
                + "&media_id="
                + Uri.EscapeDataString(mediaId);
        }
        if (url.Length == 0)
            throw new InvalidDataException("No WeWork media download source available");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var response = await http.GetAsync(url, timeout.Token);
        response.EnsureSuccessStatusCode();
        var bytes = await response.Content.ReadAsByteArrayAsync(timeout.Token);
        if (
            directUrl.Length == 0
            && response.Content.Headers.ContentType?.MediaType?.Contains(
                "application/json",
                StringComparison.Ordinal
            ) == true
        )
        {
            var result = JsonNode.Parse(bytes) as JsonObject;
            if (!Zero(result?["errcode"]))
                throw new IOException(
                    $"WeWork media download failed: {Text(result?["errmsg"])} (code: {result?["errcode"]})"
                );
        }
        if (!encrypted)
            return bytes;
        if (Nonempty(aeskey))
            return WeWorkCrypto.DecryptResource(bytes, aeskey!);
        return crypto?.DecryptAttachment(bytes)
            ?? throw new InvalidDataException(
                "Encrypted WeWork media requires aeskey or callback encodingAESKey"
            );
    }

    private static IReadOnlyList<JsonObject> Quote(List<JsonObject> parts, JsonObject payload)
    {
        var type = Text(payload["quote"]?["msgtype"]);
        if (type.Length > 0)
            parts.Add(
                new JsonObject
                {
                    ["text"] =
                        type == "text" && Nonempty(Text(payload["quote"]?["text"]?["content"]))
                            ? "[Quoted text]\n" + Text(payload["quote"]?["text"]?["content"])
                            : "[Quoted " + type + " message]",
                }
            );
        return parts;
    }

    private async Task<IReadOnlyList<JsonObject>> AibotFileAsync(
        JsonObject payload,
        string conversation,
        string kind
    )
    {
        var media = payload[kind] as JsonObject ?? new();
        var msgId = Text(payload["msgid"] ?? payload["msgId"]);
        if (msgId.Length == 0)
            msgId = "upload";
        var filename = First(media["filename"], media["file_name"], payload["file_name"]);
        if (filename.Length == 0)
            filename = "wework-" + kind + "-" + msgId + (kind == "image" ? ".jpg" : "");
        var mime = First(media["mime_type"], media["mimetype"]);
        if (mime.Length == 0)
            mime = kind == "image" ? "image/jpeg" : "application/octet-stream";
        var bytes = await DownloadAsync(
            First(payload["response_url"], config["webhookUrl"]),
            Text(media["url"]),
            "",
            true,
            Text(media["aeskey"])
        );
        return await sessions.SaveInboundChannelFileAsync(
            "wework",
            conversation,
            bytes,
            filename,
            mime,
            "",
            CancellationToken.None,
            kind == "image"
        );
    }

    private static string First(params JsonNode?[] nodes) =>
        nodes.Select(Text).FirstOrDefault(value => value.Length > 0) ?? "";

    private async Task<IReadOnlyList<JsonObject>?> BuildPartsAsync(
        JsonObject payload,
        string conversation,
        string replyWebhook,
        bool aibot
    )
    {
        var type = First(payload["msgtype"], payload["MsgType"]);
        var content = First(
            payload["text"]?["content"],
            payload["Content"],
            payload["Text"]?["Content"]
        );
        if (type == "text" && content.Length > 0)
            return Quote([new JsonObject { ["text"] = content }], payload);
        if (aibot && type is "image" or "file")
            return Quote((await AibotFileAsync(payload, conversation, type)).ToList(), payload);
        if (aibot && type == "mixed")
        {
            var parts = new List<JsonObject>();
            foreach (
                var item in (payload["mixed"]?["msg_item"] as JsonArray ?? []).OfType<JsonObject>()
            )
            {
                var itemType = Text(item["msgtype"]);
                if (itemType == "text" && Nonempty(Text(item["text"]?["content"])))
                    parts.Add(new JsonObject { ["text"] = Text(item["text"]?["content"]) });
                else if (itemType == "image")
                {
                    var nested = (JsonObject)payload.DeepClone();
                    nested["image"] = item["image"]?.DeepClone();
                    parts.AddRange(await AibotFileAsync(nested, conversation, "image"));
                }
                else
                    parts.Add(
                        new JsonObject
                        {
                            ["text"] =
                                "[Mixed item: "
                                + (itemType.Length == 0 ? "unknown" : itemType)
                                + "]",
                        }
                    );
            }
            return Quote(parts, payload);
        }
        if (aibot && type == "voice" && Nonempty(Text(payload["voice"]?["content"])))
            return Quote(
                [new JsonObject { ["text"] = Text(payload["voice"]?["content"]) }],
                payload
            );
        if (type is "image" or "file")
        {
            var direct =
                type == "image"
                    ? First(
                        payload["ImageUrl"],
                        payload["PicUrl"],
                        payload["Url"],
                        payload["image"]?["url"]
                    )
                    : First(payload["Url"], payload["file"]?["url"]);
            var mediaId = First(payload["MediaId"], payload["media_id"]);
            var bytes = await DownloadAsync(
                replyWebhook,
                direct,
                mediaId,
                Nonempty(Text(payload[type]?["url"]))
            );
            var filename = First(payload["FileName"], payload["file_name"]);
            if (filename.Length == 0)
                filename =
                    "wework-"
                    + type
                    + "-"
                    + First(
                        payload["MsgId"],
                        payload["msgid"],
                        payload["MediaId"],
                        JsonValue.Create(mediaId.Length > 0 ? mediaId : "upload")
                    )
                    + (type == "image" ? ".jpg" : "");
            var mime = First(payload["MimeType"], payload["mime_type"]);
            if (mime.Length == 0)
                mime = type == "image" ? "image/jpeg" : "application/octet-stream";
            return await sessions.SaveInboundChannelFileAsync(
                "wework",
                conversation,
                bytes,
                filename,
                mime,
                "",
                CancellationToken.None,
                type == "image"
            );
        }
        if (type == "event")
            return null;
        return
        [
            new JsonObject { ["text"] = "[" + (type.Length == 0 ? "Unknown" : type) + " message]" },
        ];
    }
}
