using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class WeWorkCallbackTests
{
    internal static string Encrypt(string text, string key = WeWorkPeer.AesKey, bool framed = true)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var raw = framed ? new byte[20 + bytes.Length + 7] : bytes.ToArray();
        if (framed)
        {
            raw.AsSpan(0, 16).Fill(42);
            BinaryPrimitives.WriteInt32BigEndian(raw.AsSpan(16, 4), bytes.Length);
            bytes.CopyTo(raw, 20);
            Encoding.UTF8.GetBytes("recv-id").CopyTo(raw, 20 + bytes.Length);
        }
        var pad = 32 - raw.Length % 32;
        var padded = new byte[raw.Length + pad];
        raw.CopyTo(padded, 0);
        padded.AsSpan(raw.Length).Fill((byte)pad);
        using var aes = Aes.Create();
        aes.Key = Convert.FromBase64String(key + "=");
        return Convert.ToBase64String(
            aes.EncryptCbc(padded, aes.Key.AsSpan(0, 16), PaddingMode.None)
        );
    }

    internal static string Sign(
        string encrypted,
        string timestamp = "1710000000",
        string nonce = "fixture-nonce"
    ) =>
        Convert.ToHexStringLower(
            SHA1.HashData(
                Encoding.UTF8.GetBytes(
                    string.Concat(
                        new[] { "fixture-token", timestamp, nonce, encrypted }.Order(
                            StringComparer.Ordinal
                        )
                    )
                )
            )
        );

    internal static JsonObject Decode(JsonObject encrypted)
    {
        var value = encrypted["encrypt"]!.GetValue<string>();
        Assert.Equal(
            Sign(value, encrypted["timestamp"]!.ToString(), encrypted["nonce"]!.GetValue<string>()),
            encrypted["msgsignature"]!.GetValue<string>()
        );
        using var aes = Aes.Create();
        aes.Key = Convert.FromBase64String(WeWorkPeer.AesKey + "=");
        var raw = aes.DecryptCbc(
            Convert.FromBase64String(value),
            aes.Key.AsSpan(0, 16),
            PaddingMode.None
        );
        Assert.InRange(raw[^1], (byte)1, (byte)32);
        Assert.Equal(0, raw.Length % 32);
        return JsonNode
            .Parse(raw.AsSpan(20, BinaryPrimitives.ReadInt32BigEndian(raw.AsSpan(16, 4))))!
            .AsObject();
    }

    internal static async Task<JsonObject> Post(
        HttpClient client,
        JsonObject body,
        bool encrypted = true,
        bool signed = true
    )
    {
        var cipher = Encrypt(body.ToJsonString());
        var url =
            encrypted && signed
                ? "callback?timestamp=1710000000&nonce=fixture-nonce&msg_signature=" + Sign(cipher)
                : "callback";
        var response = await client.PostAsJsonAsync(
            url,
            encrypted ? new JsonObject { ["encrypt"] = cipher } : body
        );
        response.EnsureSuccessStatusCode();
        var raw = await response.Content.ReadAsStringAsync();
        var payload = raw.Length == 0 ? new JsonObject() : JsonNode.Parse(raw)!.AsObject();
        return payload!.ContainsKey("encrypt") ? Decode(payload) : payload;
    }

    internal static Task<JsonObject> Refresh(HttpClient client, string stream) =>
        Post(
            client,
            new JsonObject
            {
                ["msgtype"] = "stream",
                ["stream"] = new JsonObject { ["id"] = stream },
            }
        );

    internal static string Id(JsonObject payload) => payload["stream"]!["id"]!.GetValue<string>();

    internal static string Content(JsonObject payload) =>
        payload["stream"]!["content"]!.GetValue<string>();

    [Fact]
    public async Task Configured_separate_listener_verifies_GET_and_preserves_POST_compatibility_XML_JSON_crypto_passive_dedup_and_latest_routing()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        var config = peer.Config(port);
        config.Remove("webhookUrl"); // Pure callback readiness, no administrator HTTP server.
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = config },
            dependencies: peer.Dependencies
        );
        var reload = await f.Manager.ManagedChannels!.ReloadAsync();
        Assert.Single(reload["started"]!.AsArray());
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("callback")).StatusCode);
        var echo = Encrypt("verified 企业微信");
        var query =
            "callback?timestamp=1710000000&nonce=fixture-nonce&echostr="
            + Uri.EscapeDataString(echo)
            + "&msg_signature=";
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await client.GetAsync(query + "bad")).StatusCode
        );
        Assert.Equal("verified 企业微信", await client.GetStringAsync(query + Sign(echo)));
        var first = await Post(client, WeWorkPeer.Text("first", "  body\n\tkept "));
        Assert.Equal("<think>", Content(first));
        Assert.False(first["stream"]!["finish"]!.GetValue<bool>());
        await TelegramChannelTests.Until(() =>
            f.Manager.ChannelBinding("work:wrk-chat") is not null
        );
        var sessionId = SessionWait.Text(f.Manager.ChannelBinding("work:wrk-chat")!["sessionId"])!;
        var owner = await f.Manager.GetExistingAsync(sessionId, default);
        await TelegramChannelTests.Until(() =>
            owner!.Entry.WithState(state => state.Queue.Count) == 1
        );
        var duplicate = await Post(client, WeWorkPeer.Text("first", "must not be queued"));
        Assert.Equal(Id(first), Id(duplicate));
        Assert.Equal(1, owner!.Entry.WithState(state => state.Queue.Count));
        Assert.DoesNotContain("fw_", owner.Entry.Snapshot().AuthorityEnvelope.ToJsonString());
        Assert.DoesNotContain(
            "stream",
            System.Text.Json.JsonSerializer.Serialize(
                owner.Entry.WithState(state => state.Queue[0].Source)
            )
        );
        await f
            .Manager.ChannelRegistry.Get("work")!
            .Send("wrk-chat", "explicit override", new(WebhookUrl: peer.Webhook), default);
        Assert.Equal("<think>", Content(await Refresh(client, Id(first))));
        Assert.Equal(
            "explicit override",
            peer.Calls.Single().Body["markdown"]!["content"]!.GetValue<string>()
        );
        await f.Manager.ChannelRegistry.SendAsync("work:wrk-chat", "substantive 文本", default);
        await f
            .Manager.ChannelRegistry.Get("work")!
            .Progress!("wrk-chat", new("tool-calls-start", [new("r", "read")]), default);
        var second = await Post(client, WeWorkPeer.Text("second", user: "bob"), signed: false);
        Assert.NotEqual(Id(first), Id(second));
        var old = await Refresh(client, Id(first));
        Assert.True(old["stream"]!["finish"]!.GetValue<bool>());
        Assert.Equal("substantive 文本", Content(old));
        await f
            .Manager.ChannelRegistry.Get("work")!
            .Send("wrk-chat", "latest final", new(true), default);
        var latest = await Refresh(client, Id(second));
        Assert.Equal("latest final", Content(latest));
        Assert.True(latest["stream"]!["finish"]!.GetValue<bool>());
        var missing = await Refresh(client, "unknown-stream");
        Assert.True(missing["stream"]!["finish"]!.GetValue<bool>());
        Assert.Equal("未找到对应的流式消息。", Content(missing));
        var invalidCipher = Encrypt(WeWorkPeer.Text("invalid").ToJsonString());
        var invalid = await client.PostAsJsonAsync(
            "callback?timestamp=1710000000&nonce=fixture-nonce&msg_signature=bad",
            new { encrypt = invalidCipher }
        );
        Assert.Equal(HttpStatusCode.InternalServerError, invalid.StatusCode);
        Assert.Contains(
            "Invalid WeWork callback signature",
            await invalid.Content.ReadAsStringAsync()
        );
        var headerCipher = Encrypt(WeWorkPeer.Text("header-input").ToJsonString());
        using (var headerRequest = new HttpRequestMessage(HttpMethod.Post, "callback"))
        {
            headerRequest.Headers.Add("x-tif-timestamp", "1710000000");
            headerRequest.Headers.Add("x-tif-nonce", "fixture-nonce");
            headerRequest.Headers.Add("x-tif-signature", Sign(headerCipher));
            headerRequest.Content = JsonContent.Create(new { Encrypt = headerCipher });
            var headerResponse = await client.SendAsync(headerRequest);
            Assert.Equal(
                "<think>",
                Content(Decode((await headerResponse.Content.ReadFromJsonAsync<JsonObject>())!))
            );
        }
        var partialSignature = await client.PostAsJsonAsync(
            "callback?timestamp=1710000000&msg_signature=bad",
            new { encrypt = Encrypt(WeWorkPeer.Text("partial-signature").ToJsonString()) }
        );
        Assert.Equal(
            "<think>",
            Content((await partialSignature.Content.ReadFromJsonAsync<JsonObject>())!)
        );
        var xml =
            "<xml><MsgId>xml-1</MsgId><From><UserId>alice</UserId><Name>XML sender</Name></From><ChatId>xml-chat</ChatId><ChatType>single</ChatType><MsgType>text</MsgType><Content><![CDATA[@企业机器人 /whoami]]></Content><WebhookUrl>"
            + System.Security.SecurityElement.Escape(peer.Webhook)
            + "</WebhookUrl></xml>";
        var xmlResponse = await client.PostAsync(
            "callback",
            new StringContent(xml, Encoding.UTF8, "application/xml")
        );
        Assert.Equal(
            "{\"code\":0,\"msg\":\"success\"}",
            await xmlResponse.Content.ReadAsStringAsync()
        );
        await TelegramChannelTests.Until(() =>
            peer.Calls.Any(call =>
                call.Body.ToJsonString().Contains("alice", StringComparison.Ordinal)
            )
        );
        var encryptedXml = Encrypt(xml.Replace("xml-1", "xml-2"));
        var xmlEncryptedResponse = await client.PostAsync(
            "callback?timestamp=1710000000&nonce=fixture-nonce&msg_signature=" + Sign(encryptedXml),
            new StringContent(
                "<xml><Encrypt><![CDATA[" + encryptedXml + "]]></Encrypt></xml>",
                Encoding.UTF8,
                "text/xml"
            )
        );
        Assert.True(xmlEncryptedResponse.IsSuccessStatusCode);
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await client.PostAsync(
                    "callback",
                    new StringContent("{broken", Encoding.UTF8, "application/json")
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.RequestEntityTooLarge,
            (
                await client.PostAsync(
                    "callback",
                    new StringContent(new string('x', 102401), Encoding.UTF8, "text/xml")
                )
            ).StatusCode
        );
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("not-callback")).StatusCode);
    }

    [Fact]
    public async Task Concurrent_HTTP_text_retries_atomically_reuse_initial_response_and_admit_one_Router_input_per_instance()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        var otherPort = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(port), ["other"] = peer.Config(otherPort) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        f.Manager.AttachChannel("other:wrk-chat", f.Owner);
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        using var other = new HttpClient
        {
            BaseAddress = new Uri($"http://127.0.0.1:{otherPort}/"),
        };
        var expected = 0;
        foreach (var width in Enumerable.Repeat(2, 20).Append(32))
        {
            var msgId = "overlap-" + expected;
            var start = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            var requests = Enumerable
                .Range(0, width)
                .Select(async _ =>
                {
                    await start.Task;
                    return await Post(client, WeWorkPeer.Text(msgId), encrypted: false);
                })
                .ToArray();
            start.SetResult();
            var responses = await Task.WhenAll(requests);
            Assert.Single(responses.Select(Id).Distinct());
            await f.Manager.ChannelRegistry.SendAsync("work:wrk-chat", "later output", default);
            Assert.Equal(
                Content(responses[0]),
                Content(await Post(client, WeWorkPeer.Text(msgId), encrypted: false))
            );
            expected++;
            await TelegramChannelTests.Until(() =>
                f.Owner.Entry.WithState(state => state.Queue.Count) >= expected
            );
            Assert.Equal(expected, f.Owner.Entry.WithState(state => state.Queue.Count));
        }
        var independent = await Task.WhenAll(
            Enumerable
                .Range(0, 8)
                .Select(i => Post(client, WeWorkPeer.Text("different-" + i), encrypted: false))
        );
        Assert.Equal(8, independent.Select(Id).Distinct().Count());
        expected += 8;
        var perInstance = await Post(other, WeWorkPeer.Text("overlap-0"), encrypted: false);
        Assert.NotEqual(Id(independent[0]), Id(perInstance));
        expected++;
        var withoutIds = await Task.WhenAll(
            Enumerable.Range(0, 2).Select(_ => Post(client, WeWorkPeer.Text(""), encrypted: false))
        );
        Assert.Equal(2, withoutIds.Select(Id).Distinct().Count());
        expected += 2;
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) >= expected
        );
        Assert.Equal(expected, f.Owner.Entry.WithState(state => state.Queue.Count));
    }

    [Fact]
    public async Task Async_media_preparation_does_not_block_unrelated_text_and_failed_preparation_can_retry_same_msgid()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(port) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (call.Path != "/held-media")
                return null;
            entered.TrySetResult();
            await release.Task;
            return Results.StatusCode(500);
        };
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var media = WeWorkPeer.Text("retry-media");
        media["msgtype"] = "file";
        media["file"] = new JsonObject
        {
            ["url"] = new Uri(peer.Address, "held-media").ToString(),
            ["filename"] = "retry.txt",
        };
        var pending = client.PostAsJsonAsync("callback", media);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await Post(client, WeWorkPeer.Text("independent"), encrypted: false)
                .WaitAsync(TimeSpan.FromSeconds(3));
            Assert.False(pending.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        using var failed = await pending;
        Assert.Equal(HttpStatusCode.InternalServerError, failed.StatusCode);
        peer.Respond = null;
        peer.Media["/held-media"] = Convert.FromBase64String(
            Encrypt("retried bytes", framed: false)
        );
        var retried = await Post(client, media, encrypted: false);
        Assert.Equal(Id(retried), Id(await Post(client, media, encrypted: false)));
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 2
        );
        Assert.Contains(
            f.Owner.Entry.WithState(state => state.Queue.ToArray()),
            row =>
                row.Parts!.Any(part =>
                    (SessionWait.Text(part["text"] ?? part["system"]) ?? "").Contains(
                        "retry.txt",
                        StringComparison.Ordinal
                    )
                )
        );
    }

    [Fact]
    public async Task Callback_dedup_and_cards_expire_after_fifteen_minutes_without_persisted_context()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        var now = DateTimeOffset.UtcNow;
        var config = peer.Config(port);
        config["aibot"]!["streamMaxContentBytes"] = 1e12;
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = config },
            dependencies: peer.Dependencies with
            {
                Now = () => now,
            }
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("work:wrk-chat", f.Owner);
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var first = await Post(client, WeWorkPeer.Text("ttl"));
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 1
        );
        Assert.Equal(Id(first), Id(await Post(client, WeWorkPeer.Text("ttl"))));
        await f.Manager.ChannelRegistry.SendAsync(
            "work:wrk-chat",
            new string('文', 10000),
            default
        );
        var clamped = Content(await Refresh(client, Id(first)));
        Assert.InRange(Encoding.UTF8.GetByteCount(clamped), 1, 20480);
        Assert.EndsWith("…[内容过长，已截断]", clamped);
        now += TimeSpan.FromMinutes(16);
        Assert.Equal("未找到对应的流式消息。", Content(await Refresh(client, Id(first))));
        var second = await Post(client, WeWorkPeer.Text("ttl"));
        Assert.NotEqual(Id(first), Id(second));
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 2
        );
    }

    [Fact]
    public async Task Plain_legacy_unknown_events_media_and_resource_keys_use_existing_eager_type_keyed_file_image_owners()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        var port = WeWorkPeer.Port();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(port) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("wework:media-chat", f.Owner); // Source storage type, not configured ID.
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var key = Convert.ToBase64String(Enumerable.Repeat((byte)71, 32).ToArray()).TrimEnd('=');
        var image = TelegramChannelTests.Jpeg();
        // Encrypt raw bytes for the image resource, independently of callback framing/key.
        using (var aes = Aes.Create())
        {
            aes.Key = Convert.FromBase64String(key + "=");
            var pad = 32 - image.Length % 32;
            var bytes = new byte[image.Length + pad];
            image.CopyTo(bytes, 0);
            bytes.AsSpan(image.Length).Fill((byte)pad);
            peer.Media["/image"] = aes.EncryptCbc(bytes, aes.Key.AsSpan(0, 16), PaddingMode.None);
        }
        peer.Media["/file"] = Convert.FromBase64String(Encrypt("generic contents", framed: false));
        var mixed = WeWorkPeer.Text("media", chat: "media-chat", user: "unauthorized");
        mixed["msgtype"] = "mixed";
        mixed["mixed"] = new JsonObject
        {
            ["msg_item"] = new JsonArray(
                new JsonObject
                {
                    ["msgtype"] = "text",
                    ["text"] = new JsonObject { ["content"] = "mixed body" },
                },
                new JsonObject
                {
                    ["msgtype"] = "image",
                    ["image"] = new JsonObject
                    {
                        ["url"] = new Uri(peer.Address, "image").ToString(),
                        ["aeskey"] = key,
                        ["filename"] = "photo & quote.jpg",
                    },
                },
                new JsonObject { ["msgtype"] = "video" }
            ),
        };
        mixed["quote"] = new JsonObject
        {
            ["msgtype"] = "text",
            ["text"] = new JsonObject { ["content"] = "quoted" },
        };
        await Post(client, mixed);
        Assert.NotEmpty(
            Directory.GetFiles(
                Path.Combine(f.Manager.AgentDirectory("main"), ".temp/channel-files/wework")
            )
        );
        Assert.Empty(f.Owner.History());
        var admitted = (JsonObject)mixed.DeepClone();
        admitted["msgid"] = "media-allowed";
        admitted["from"]!["userid"] = "alice";
        f.Manager.AttachChannel("work:media-chat", f.Owner);
        await Post(client, admitted);
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 1
        );
        var parts = f.Owner.Entry.WithState(state => state.Queue.Single().Parts!);
        Assert.Contains(parts, part => part["inlineDataRef"] is not null);
        Assert.Contains(
            "photo &amp; quote.jpg",
            string.Join("", parts.Select(part => SessionWait.Text(part["text"] ?? part["system"])))
        );
        var file = WeWorkPeer.Text("file", chat: "media-chat");
        file["msgtype"] = "file";
        file["file"] = new JsonObject
        {
            ["url"] = new Uri(peer.Address, "file").ToString(),
            ["filename"] = "report.txt",
        };
        await Post(client, file);
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 2
        );
        Assert.Contains(
            Directory.GetFiles(
                Path.Combine(f.Manager.AgentDirectory("main"), ".temp/channel-files/wework")
            ),
            path => File.ReadAllText(path) == "generic contents"
        );
        var voice = WeWorkPeer.Text("voice", chat: "media-chat");
        voice["msgtype"] = "voice";
        voice["voice"] = new JsonObject { ["content"] = "voice transcript" };
        await Post(client, voice);
        var unknown = WeWorkPeer.Text("unknown", chat: "media-chat");
        unknown["msgtype"] = "video";
        await Post(client, unknown);
        var ignored = WeWorkPeer.Text("event", chat: "media-chat");
        ignored["msgtype"] = "event";
        await Post(client, ignored);
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 4
        );
        Assert.Equal(4, f.Owner.Entry.WithState(state => state.Queue.Count));
        var legacy = new JsonObject
        {
            ["From"] = new JsonObject { ["UserId"] = "alice" },
            ["ChatId"] = "media-chat",
            ["MsgType"] = "file",
            ["MediaId"] = "legacy-file",
        };
        peer.Respond = call =>
            Task.FromResult<IResult?>(
                call.Path.EndsWith("get_media", StringComparison.Ordinal)
                    ? Results.Bytes(
                        Encoding.UTF8.GetBytes("legacy bytes"),
                        "application/octet-stream"
                    )
                    : null
            );
        await Post(client, legacy, encrypted: false);
        await TelegramChannelTests.Until(() =>
            f.Owner.Entry.WithState(state => state.Queue.Count) == 5
        );
        Assert.Contains(
            peer.Calls,
            call => call.Query.GetValueOrDefault("media_id") == "legacy-file"
        );
    }
}
