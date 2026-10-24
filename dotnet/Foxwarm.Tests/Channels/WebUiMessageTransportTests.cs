using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiMessageTransportTests
{
    private const string Opaque = "opaque-😀e\u0301";

    private static JsonObject Obj(string text) => JsonNode.Parse(text)!.AsObject();

    internal static JsonObject Message()
    {
        var message = ResponsesCanonicalConverter.ConvertAssistant(
            Obj(
                """{"output":[{"type":"reasoning","summary":[{"text":"Visible summary"}],"encrypted_content":"placeholder"},{"type":"function_call","call_id":"valid","name":"read","arguments":"{\"filePath\":\"fixture.txt\"}"},{"type":"function_call","call_id":"invalid","name":"read","arguments":"{broken"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Answer","annotations":[{"type":"url_citation","url":"https://example.com/","title":"Citation"}]}]},{"type":"web_search_call","id":"search","action":{"type":"search","query":"public query"}}],"usage":{"input_tokens":5,"output_tokens":3,"output_tokens_details":{"reasoning_tokens":2}}}"""
            ),
            "fixture/model",
            1000,
            20
        )!;
        var parts = message["parts"]!.AsArray();
        parts[0]!["providerMeta"]!["encryptedThinking"] = Opaque;
        parts.Add(Obj("""{"providerMeta":{"redactedThinking":""}}"""));
        parts.Add(Obj("""{"thinking":"","providerMeta":{"signature":"signed-reasoning"}}"""));
        // Source-known replay metadata may contain a second copy of opaque reasoning.
        parts.Add(
            new JsonObject
            {
                ["providerMeta"] = new JsonObject
                {
                    ["openaiResponses"] = new JsonObject
                    {
                        ["sourceModelId"] = "fixture/model",
                        ["outputItem"] = new JsonObject
                        {
                            ["type"] = "reasoning",
                            ["encrypted_content"] = Opaque,
                            ["summary"] = new JsonArray(),
                        },
                    },
                },
            }
        );
        parts.Add(
            Obj(
                """{"functionResponse":{"tool_use_id":"nested-result","name":"fixture","response":{"role":"model","parts":[{"functionCall":{"rawArgsText":"nested raw","args":{}},"providerMeta":{"encryptedThinking":"nested opaque","signature":"nested signature"}}]}}}"""
            )
        );
        message["providerMeta"] = Obj(
            """{"sourceModelId":"fixture/model","providerSpecificFields":{"reasoning_signature":"replay-signature","other":{"encryptedThinking":"opaque application data"}}}"""
        );
        return message;
    }

    internal static void AssertProjected(JsonObject message)
    {
        var parts = message["parts"]!.AsArray();
        Assert.Null(parts[0]!["providerMeta"]!["encryptedThinking"]);
        Assert.Equal(
            Opaque.Length,
            parts[0]!["providerMeta"]!["encryptedThinkingLength"]!.GetValue<int>()
        );
        Assert.Equal("Visible summary", parts[0]!["thinking"]!.GetValue<string>());
        Assert.Null(parts[1]!["functionCall"]!["rawArgsText"]);
        Assert.Equal(
            "fixture.txt",
            parts[1]!["functionCall"]!["args"]!["filePath"]!.GetValue<string>()
        );
        Assert.Equal("{broken", parts[2]!["functionCall"]!["rawArgsText"]!.GetValue<string>());
        Assert.NotNull(parts[2]!["functionCall"]!["argsParseError"]);
        Assert.Equal(
            "Citation",
            parts[3]!["providerMeta"]!["openaiResponses"]!["annotations"]![0]![
                "title"
            ]!.GetValue<string>()
        );
        Assert.Equal(
            "public query",
            parts[4]!["providerMeta"]!["openaiResponses"]!["outputItem"]!["action"]![
                "query"
            ]!.GetValue<string>()
        );
        Assert.Equal(0, parts[5]!["providerMeta"]!["redactedThinkingLength"]!.GetValue<int>());
        Assert.Null(parts[5]!["providerMeta"]!["redactedThinking"]);
        Assert.Null(parts[6]!["providerMeta"]!["signature"]);
        Assert.Equal(
            "signed-reasoning".Length,
            parts[6]!["providerMeta"]!["signatureLength"]!.GetValue<int>()
        );
        Assert.Null(
            parts[7]!["providerMeta"]!["openaiResponses"]!["outputItem"]!["encrypted_content"]
        );
        Assert.Equal(
            Opaque.Length,
            parts[7]!["providerMeta"]!["openaiResponses"]!["outputItem"]![
                "encryptedThinkingLength"
            ]!.GetValue<int>()
        );
        var nested = parts[8]!["functionResponse"]!["response"]!["parts"]![0]!;
        Assert.Equal("nested raw", nested["functionCall"]!["rawArgsText"]!.GetValue<string>());
        Assert.Equal(
            "nested opaque",
            nested["providerMeta"]!["encryptedThinking"]!.GetValue<string>()
        );
        var fields = message["providerMeta"]!["providerSpecificFields"]!;
        Assert.Null(fields["reasoning_signature"]);
        Assert.Equal(
            "replay-signature".Length,
            fields["reasoning_signature_length"]!.GetValue<int>()
        );
        Assert.Equal(
            "opaque application data",
            fields["other"]!["encryptedThinking"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Projection_uses_UTF16_lengths_preserves_presence_and_only_touches_known_message_fields()
    {
        var original = Message();
        var before = original.ToJsonString();
        var projected = WebUiMessageTransport.Message(original);
        AssertProjected(projected);
        Assert.Equal(before, original.ToJsonString());
        Assert.Equal(before, Foxwarm.Images.ImageTransport.Project(original)!.ToJsonString());
        Assert.Equal(
            projected.ToJsonString(),
            WebUiMessageTransport.Message(projected).ToJsonString()
        );
        var presence = Obj(
            """{"role":"model","parts":[{"functionCall":{"args":{},"rawArgsText":"keep null","argsParseError":null},"providerMeta":{"encryptedThinking":"","signature":""}},{"functionCall":{"args":{},"rawArgsText":"keep empty","argsParseError":""},"providerMeta":{"encryptedThinking":null}},{"providerMeta":{}}]}"""
        );
        var result = WebUiMessageTransport.Message(presence)["parts"]!;
        Assert.Equal("keep null", result[0]!["functionCall"]!["rawArgsText"]!.GetValue<string>());
        Assert.Equal("keep empty", result[1]!["functionCall"]!["rawArgsText"]!.GetValue<string>());
        Assert.Equal(0, result[0]!["providerMeta"]!["encryptedThinkingLength"]!.GetValue<int>());
        Assert.Equal(0, result[0]!["providerMeta"]!["signatureLength"]!.GetValue<int>());
        Assert.True(result[1]!["providerMeta"]!.AsObject().ContainsKey("encryptedThinking"));
        Assert.Null(result[1]!["providerMeta"]!["encryptedThinkingLength"]);
        Assert.Empty(result[2]!["providerMeta"]!.AsObject());
    }

    [Fact]
    public void Real_provider_converters_keep_full_opaque_values_for_same_model_replay_after_projection()
    {
        var responses = ResponsesCanonicalConverter.ConvertAssistant(
            Obj(
                """{"output":[{"type":"reasoning","encrypted_content":"cipher-😀","summary":[]}]}"""
            ),
            "p/m",
            100,
            1
        )!;
        var anthropic = AnthropicCanonicalConverter.ConvertAssistant(
            Obj(
                """{"content":[{"type":"thinking","thinking":"","signature":"signature-😀"},{"type":"redacted_thinking","data":"redacted-😀"}],"stop_reason":"end_turn"}"""
            ),
            "p/m",
            100,
            1
        )!;
        var completions = CompletionsCanonicalConverter.ConvertAssistant(
            Obj(
                """{"choices":[{"message":{"content":"answer","provider_specific_fields":{"reasoning_signature":"signature-😀","other":17}}}]}"""
            ),
            "p/m",
            100,
            1
        );
        foreach (var message in new[] { responses, anthropic, completions })
        {
            var before = message.ToJsonString();
            var projected = WebUiMessageTransport.Message(message);
            Assert.DoesNotContain("signature-", projected.ToJsonString());
            Assert.DoesNotContain("cipher-", projected.ToJsonString());
            Assert.DoesNotContain("redacted-", projected.ToJsonString());
            Assert.Equal(before, message.ToJsonString());
        }
        Assert.Equal(
            "cipher-😀",
            ResponsesRequestSerializer.BuildRequest([responses], "m", "p/m", "", 100)["input"]![0]![
                "encrypted_content"
            ]!.GetValue<string>()
        );
        var blocks = AnthropicRequestSerializer.ConvertHistory(
            [anthropic],
            new Uri("https://example.com")
        )[0]!["content"]!;
        Assert.Equal("signature-😀", blocks[0]!["signature"]!.GetValue<string>());
        Assert.Equal("redacted-😀", blocks[1]!["data"]!.GetValue<string>());
        Assert.Equal(
            "signature-😀",
            CompletionsRequestSerializer.ConvertHistory([completions], "p/m", "reasoning_content")[
                0
            ]!["provider_specific_fields"]!["reasoning_signature"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task HTTP_history_debug_context_archive_and_live_WS_SSE_share_projection_without_rewriting_authority()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "payload", null, null);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", "Bearer " + WebUiDownloadTests.Fixture.Token);
        await ws.ConnectAsync(
            new UriBuilder(new Uri(f.Admin.BaseAddress!, "api/webui/stream")) { Scheme = "ws" }.Uri,
            deadline.Token
        );
        await Receive(ws, "connected", deadline.Token);
        await ws.SendAsync(
            Encoding.UTF8.GetBytes(
                """{"type":"set-subscriptions","revision":1,"sessionIds":["payload"],"sessionListIds":[],"sessionListActive":false}"""
            ),
            WebSocketMessageType.Text,
            true,
            deadline.Token
        );
        await Receive(ws, "subscriptions-applied", deadline.Token);
        using var sse = await f.Admin.GetAsync(
            "api/sessions/payload/stream",
            HttpCompletionOption.ResponseHeadersRead,
            deadline.Token
        );
        using var reader = new StreamReader(await sse.Content.ReadAsStreamAsync(deadline.Token));
        await Receive(reader, "connected", deadline.Token);
        await Receive(reader, "session-state", deadline.Token);
        await ForkClearLifecycleTests.AppendAsync(owner, Message());
        var canonical = owner.History().Single().ToJsonString();
        var archive = owner.Archive.ReadMessages().Single().MessageJson;
        AssertProjected((await Receive(ws, "message", deadline.Token))["message"]!.AsObject());
        AssertProjected((await Receive(reader, "message", deadline.Token))["message"]!.AsObject());
        var history = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/payload/history"))!;
        AssertProjected(history["messages"]![0]!.AsObject());
        var version = history["historyVersion"]!.GetValue<long>();
        foreach (
            var query in new[]
            {
                "?tail=1",
                $"?afterSeq=0&historyVersion={version}",
                $"?prefixLength=1&historyVersion={version}",
            }
        )
            AssertProjected(
                (
                    await f.Admin.GetFromJsonAsync<JsonObject>(
                        "api/sessions/payload/history" + query
                    )
                )!["messages"]![0]!.AsObject()
            );
        AssertProjected(
            (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/payload/debug-file"))![
                "payload"
            ]!["history"]![0]!.AsObject()
        );
        AssertProjected(
            (
                await f.Admin.GetFromJsonAsync<JsonObject>(
                    "api/sessions/payload/history/continuous"
                )
            )!["messages"]![0]!.AsObject()
        );
        var exact = (
            await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/payload/archive/messages/1")
        )!;
        AssertProjected(exact["message"]!.AsObject());
        AssertProjected(Obj(exact["messageJson"]!.GetValue<string>()));
        AssertProjected(
            (
                await f.Admin.GetFromJsonAsync<JsonObject>(
                    "api/history/window?sessionId=payload&target=msg%231"
                )
            )!["messages"]![0]!.AsObject()
        );
        owner.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                owner.Id,
                "main",
                1,
                1,
                "message",
                1,
                1,
                null,
                1,
                1,
                1000,
                1000,
                "summary",
                null,
                1000
            ),
        ]);
        var context = (
            await f.Admin.GetFromJsonAsync<JsonObject>(
                "api/sessions/payload/context-blocks/1/expand"
            )
        )!;
        AssertProjected(context["messages"]![0]!.AsObject());
        AssertProjected(context["items"]![0]!["message"]!.AsObject());
        var runtime = new SessionRuntime(f.Manager);
        var batch = WebUiContract.Event(
            new(
                owner.Id,
                SessionEventKind.QueueHistoryAppended,
                new JsonArray(owner.History().Single()),
                owner.Entry.Snapshot()
            ),
            runtime
        );
        AssertProjected(batch["messages"]![0]!.AsObject());
        Assert.Equal(canonical, owner.History().Single().ToJsonString());
        Assert.Equal(archive, owner.Archive.ReadMessages().Single().MessageJson);
        Assert.Equal(
            canonical,
            (await owner.AuthorityStore.LoadAsync(owner.Id))!.History.Single().ToJsonString()
        );
        ws.Abort();
    }

    internal static async Task<JsonObject> Receive(
        ClientWebSocket ws,
        string type,
        CancellationToken token
    )
    {
        while (true)
        {
            using var data = new MemoryStream();
            var buffer = new byte[8192];
            WebSocketReceiveResult received;
            do
            {
                received = await ws.ReceiveAsync(buffer, token);
                if (received.MessageType == WebSocketMessageType.Close)
                    throw new IOException("Unexpected WebSocket close");
                data.Write(buffer, 0, received.Count);
            } while (!received.EndOfMessage);
            var frame = JsonNode.Parse(data.ToArray())!.AsObject();
            if (SessionWait.Text(frame["type"]) == type)
                return frame;
        }
    }

    private static async Task<JsonObject> Receive(
        StreamReader reader,
        string type,
        CancellationToken token
    )
    {
        while (await reader.ReadLineAsync(token) is { } line)
        {
            if (!line.StartsWith("data: ", StringComparison.Ordinal))
                continue;
            var frame = JsonNode.Parse(line[6..])!.AsObject();
            if (SessionWait.Text(frame["type"]) == type)
                return frame;
        }
        throw new IOException("Unexpected SSE end");
    }
}
