using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Hosting;

namespace Foxwarm.Channels;

internal sealed partial class WeWorkChannel
{
    private async Task StartListenerAsync(int port, string path)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.Limits.MaxRequestBodySize = 100 * 1024; // Express json/text default.
            options.Listen(callbackAddress, port);
        });
        var app = builder.Build();
        // Kestrel can dispatch another request on a draining keep-alive connection.
        // Source server.close closes idle connections; keep already-entered handlers independent.
        app.Use(
            (context, next) =>
            {
                if (stopped)
                {
                    context.Abort();
                    return Task.CompletedTask;
                }
                return next(context);
            }
        );
        app.MapMethods(path, ["GET", "HEAD"], VerifyCallback);
        app.MapPost(path, (Delegate)HandleCallbackAsync);
        try
        {
            await app.StartAsync();
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
        listener = app;
    }

    private IResult VerifyCallback(HttpRequest request)
    {
        try
        {
            if (crypto is null)
                return Results.Text("Missing crypto config", statusCode: 400);
            var timestamp = request.Query["timestamp"].FirstOrDefault() ?? "";
            var nonce = request.Query["nonce"].FirstOrDefault() ?? "";
            var echo = request.Query["echostr"].FirstOrDefault() ?? "";
            try
            {
                echo = Uri.UnescapeDataString(echo);
            }
            catch (UriFormatException) { }
            var signature = request.Query["msg_signature"].FirstOrDefault() ?? "";
            if (
                timestamp.Length == 0
                || nonce.Length == 0
                || echo.Length == 0
                || signature.Length == 0
            )
                return Results.Text("Missing verification query", statusCode: 400);
            if (!crypto.Verify(signature, timestamp, nonce, echo))
                return Results.Text("Invalid signature", statusCode: 401);
            return Results.Text(crypto.DecryptCallback(echo), "text/plain");
        }
        catch (Exception error)
        {
            log(error);
            return Results.Text(error.Message, statusCode: 500);
        }
    }

    private static JsonNode XmlValue(XElement element)
    {
        if (!element.HasElements)
            return JsonValue.Create(element.Value)!;
        var result = new JsonObject();
        foreach (var group in element.Elements().GroupBy(child => child.Name.LocalName))
        {
            var children = group.Select(XmlValue).ToArray();
            result[group.Key] = children.Length == 1 ? children[0] : new JsonArray(children);
        }
        return result;
    }

    private static JsonObject? ParseXml(string text)
    {
        using var reader = XmlReader.Create(
            new StringReader(text),
            new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }
        );
        var root = XDocument.Load(reader).Root;
        if (root is null)
            return null;
        var value = XmlValue(root);
        return root.Name.LocalName == "xml"
            ? value as JsonObject
            : new JsonObject { [root.Name.LocalName] = value };
    }

    private async Task<IResult> HandleCallbackAsync(HttpRequest request)
    {
        JsonObject? body = null;
        var contentType = request.ContentType?.Split(';')[0].Trim() ?? "";
        string raw;
        try
        {
            using var reader = new StreamReader(request.Body);
            raw = await reader.ReadToEndAsync();
            if (contentType == "application/json" && raw.Length > 0)
            {
                var value = JsonNode.Parse(raw);
                if (value is not JsonObject and not JsonArray)
                    return Results.StatusCode(400);
                body = value as JsonObject;
            }
        }
        catch (BadHttpRequestException error)
        {
            return Results.StatusCode(error.StatusCode);
        }
        catch (JsonException)
        {
            return Results.StatusCode(400);
        }
        try
        {
            if (contentType is "application/xml" or "text/xml" && raw.Length > 0)
                body = ParseXml(raw);
            var isAibot = false;
            var encrypted = Text(body?["encrypt"]);
            if (encrypted.Length == 0)
                encrypted = Text(body?["Encrypt"]);
            var timestamp = "";
            var nonce = "";
            if (encrypted.Length > 0)
            {
                if (crypto is null)
                    body = null;
                else
                {
                    timestamp =
                        request.Query["timestamp"].FirstOrDefault()
                        ?? request.Headers["x-tif-timestamp"].FirstOrDefault()
                        ?? "";
                    nonce =
                        request.Query["nonce"].FirstOrDefault()
                        ?? request.Headers["x-tif-nonce"].FirstOrDefault()
                        ?? "";
                    var signature =
                        request.Query["msg_signature"].FirstOrDefault()
                        ?? request.Headers["x-tif-signature"].FirstOrDefault()
                        ?? "";
                    // Source compatibility: POST validates only when all three inputs were supplied.
                    if (
                        timestamp.Length > 0
                        && nonce.Length > 0
                        && signature.Length > 0
                        && !crypto.Verify(signature, timestamp, nonce, encrypted)
                    )
                        throw new InvalidDataException("Invalid WeWork callback signature");
                    var plaintext = crypto.DecryptCallback(encrypted).Trim();
                    body =
                        plaintext.StartsWith('{') || plaintext.StartsWith('[')
                            ? JsonNode.Parse(plaintext) as JsonObject
                        : plaintext.Length == 0 ? null
                        : ParseXml(plaintext);
                    isAibot =
                        body?["response_url"] is JsonValue response
                            && response.TryGetValue<string>(out _)
                        || body?["aibotid"] is JsonValue bot && bot.TryGetValue<string>(out _)
                        || Text(body?["msgtype"]) == "stream";
                }
            }
            if (body is null)
                return Results.Json(new { code = 0, msg = "success" });
            var result = await ProcessInboundAsync(
                body,
                new("webhook", Text(body["response_url"])),
                isAibot
            );
            if (result is not null)
                return Results.Json(
                    encrypted.Length > 0
                    && timestamp.Length > 0
                    && nonce.Length > 0
                    && crypto is not null
                        ? crypto.EncryptCallback(result.ToJsonString(), timestamp, nonce)
                        : result
                );
            return isAibot || Nonempty(Text(body["response_url"]))
                ? Results.Text("")
                : Results.Json(new { code = 0, msg = "success" });
        }
        catch (Exception error)
        {
            log(error);
            return Results.Json(
                new
                {
                    code = -1,
                    msg = "error",
                    error = error.Message,
                },
                statusCode: 500
            );
        }
    }

    private async Task<JsonObject?> ProcessInboundAsync(
        JsonObject? body,
        WeWorkDelivery delivery,
        bool isAibot
    )
    {
        if (body is null)
            return null;
        var msgId = Text(body["msgid"]);
        if (msgId.Length == 0)
            msgId = Text(body["MsgId"] ?? body["xml"]?["MsgId"]);
        msgId = msgId.Trim();
        lock (contextGate)
        {
            foreach (var (key, value) in processed.ToArray())
                if (now().ToUnixTimeMilliseconds() - value.At > 15 * 60 * 1000)
                    processed.Remove(key);
            if (isAibot && Text(body["msgtype"]) == "stream")
            {
                var streamId = Text(body["stream"]?["id"]);
                return streams.Get(streamId, true)?.Payload()
                    ?? new JsonObject
                    {
                        ["msgtype"] = "stream",
                        ["stream"] = new JsonObject
                        {
                            ["id"] = Nonempty(streamId)
                                ? streamId
                                : "fw_missing_" + now().ToUnixTimeMilliseconds(),
                            ["finish"] = true,
                            ["content"] = "未找到对应的流式消息。",
                        },
                    };
            }
            if (msgId.Length > 0 && processed.TryGetValue(msgId, out var duplicate))
                return duplicate.Response?.DeepClone() as JsonObject;
        }
        string user = "unknown",
            username = "unknown",
            chatType = "unknown",
            chatId = "";
        var replyWebhook = webhook;
        var responseUrl = delivery.Mode == "webhook" ? delivery.ResponseUrl ?? "" : "";
        IReadOnlyList<JsonObject>? parts = null;
        var messageIsAibot = isAibot;
        if (
            body["msgtype"] is JsonValue type
            && type.TryGetValue<string>(out _)
            && Nonempty(Text(body["from"]?["userid"]))
        )
        {
            user = Text(body["from"]?["userid"]);
            username = Nonempty(Text(body["from"]?["name"])) ? Text(body["from"]?["name"]) : user;
            chatType = Nonempty(Text(body["chattype"])) ? Text(body["chattype"]) : "unknown";
            chatId = Text(body["chatid"]);
            responseUrl = Nonempty(Text(body["response_url"]))
                ? Text(body["response_url"])
                : responseUrl;
            messageIsAibot |= responseUrl.Length > 0 || Nonempty(Text(body["aibotid"]));
            parts = await BuildPartsAsync(
                body,
                chatId.Length > 0 ? chatId : user,
                responseUrl.Length > 0 ? responseUrl : replyWebhook,
                messageIsAibot
            );
        }
        else if (
            body["xml"] is JsonObject wrapped && Nonempty(Text(wrapped["From"]?["UserId"]))
            || Nonempty(Text(body["From"]?["UserId"]))
        )
        {
            var xml = body["xml"] as JsonObject ?? body;
            user = Text(xml["From"]?["UserId"]);
            username = Nonempty(Text(xml["From"]?["Name"])) ? Text(xml["From"]?["Name"]) : user;
            chatType = Nonempty(Text(xml["ChatType"])) ? Text(xml["ChatType"]) : "unknown";
            chatId = Text(xml["ChatId"]);
            replyWebhook = Nonempty(Text(xml["WebhookUrl"])) ? Text(xml["WebhookUrl"]) : webhook;
            parts = await BuildPartsAsync(
                xml,
                chatId.Length > 0 ? chatId : user,
                replyWebhook,
                false
            );
        }
        JsonObject? passive = null;
        ExternalChannelContext? dispatch = null;
        WeWorkStreamSnapshot? oldPush = null,
            initialPush = null;
        // Preparation may await media; only admission/card/result mutation is atomic.
        lock (contextGate)
        {
            if (msgId.Length > 0 && processed.TryGetValue(msgId, out var duplicate))
                return duplicate.Response?.DeepClone() as JsonObject;
            if (parts is { Count: > 0 } && user != "unknown")
            {
                var conversation = chatId.Length > 0 ? chatId : user;
                WeWorkStreamSnapshot? stream = null;
                if (streamEnabled && messageIsAibot)
                {
                    var started = streams.Begin(
                        conversation,
                        delivery.Mode == "webhook"
                            ? delivery with
                            {
                                ResponseUrl = responseUrl,
                            }
                            : delivery
                    );
                    stream = started.Current;
                    responseUrls.Remove(conversation);
                    if (started.Old?.Delivery.Mode == "websocket")
                        oldPush = started.Old;
                    if (stream.Delivery.Mode == "websocket")
                        initialPush = stream;
                    else
                        passive = stream.Payload();
                }
                else if (responseUrl.Length > 0)
                {
                    responseUrls.Remove(conversation);
                    if (responseUrls.Count >= 1024)
                        responseUrls.Remove(responseUrls.Keys.First());
                    responseUrls[conversation] = responseUrl;
                }
                dispatch = new ExternalChannelContext(
                    id,
                    "wework",
                    conversation,
                    user,
                    username,
                    text =>
                        stream is not null
                            ? SendTextAsync(
                                conversation,
                                text,
                                new(
                                    WebhookUrl: replyWebhook,
                                    StreamId: stream.Id,
                                    ChatId: chatId,
                                    ChatType: chatType
                                ),
                                CancellationToken.None
                            )
                        : responseUrl.Length > 0
                            ? SendResponseAsync(responseUrl, text, CancellationToken.None)
                        : SendTextAsync(
                            conversation,
                            text,
                            new(WebhookUrl: replyWebhook, ChatId: chatId, ChatType: chatType),
                            CancellationToken.None
                        ),
                    Nonempty(Text(config["selfName"])) ? Text(config["selfName"]).Trim() : null
                );
            }
            if (msgId.Length > 0)
                processed[msgId] = (
                    now().ToUnixTimeMilliseconds(),
                    passive?.DeepClone() as JsonObject
                );
        }
        if (dispatch is not null)
        {
            var conversation = chatId.Length > 0 ? chatId : user;
            Console.WriteLine(
                "WeWork inbound: "
                    + new JsonObject
                    {
                        ["channelId"] = id,
                        ["deliveryMode"] = delivery.Mode,
                        ["msgId"] = msgId,
                        ["conversationId"] = conversation,
                        ["chatType"] = chatType,
                        ["senderId"] = user,
                        ["username"] = username,
                        ["isAIBot"] = messageIsAibot,
                        ["hasResponseUrl"] = responseUrl.Length > 0,
                    }.ToJsonString()
            );
        }
        if (oldPush is not null)
            _ = ObserveAsync(PushStreamAsync(oldPush, CancellationToken.None));
        if (initialPush is not null)
            _ = ObserveAsync(PushStreamAsync(initialPush, CancellationToken.None));
        if (dispatch is not null)
            _ = ObserveAsync(router.HandleExternalMessageAsync(dispatch, new(parts!)));
        return passive;
    }
}
