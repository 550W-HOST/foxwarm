using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TextRedactionProtocolsTests
{
    [Theory]
    [InlineData("openai-responses", true)]
    [InlineData("openai-completions", true)]
    [InlineData("anthropic", false)]
    [InlineData("anthropic", true)]
    public async Task Configured_protocols_redact_semantic_inputs_and_restore_only_ordinary_output(
        string protocol,
        bool stream
    )
    {
        const string secret = "private@example.test";
        const string opaque = "opaque-only";
        await using var detector = await TextDetectionPeer.StartAsync(secret, opaque);
        string? key = null;
        Exception? peerFailure = null;
        await using var peer = new LoopbackResponsesServer(
            async (connection, request) =>
            {
                try
                {
                    var body = JsonNode.Parse(request.Body)!.AsObject();
                    key = (
                        protocol == "anthropic" ? body["system"]
                        : protocol == "openai-completions" ? body["messages"]![0]!["content"]
                        : body["instructions"]
                    )!.GetValue<string>();
                    Assert.StartsWith("[[FW_PRIVATE_", key);
                    Assert.Equal(opaque, body["opaque"]!.GetValue<string>());
                    Assert.Equal(opaque, request.Headers["X-Opaque"]);
                    var tools = body["tools"]!.AsArray();
                    var tool =
                        protocol == "openai-completions" ? tools[0]!["function"]! : tools[0]!;
                    Assert.Equal(secret, tool["name"]!.GetValue<string>());
                    Assert.Equal(key, tool["description"]!.GetValue<string>());
                    var schema = tool[protocol == "anthropic" ? "input_schema" : "parameters"]!;
                    Assert.Equal(
                        key,
                        schema["properties"]![secret]!["description"]!.GetValue<string>()
                    );
                    Assert.Equal(secret, schema["required"]![0]!.GetValue<string>());
                    Assert.Equal(
                        secret,
                        schema["examples"]![0]!["description"]!.GetValue<string>()
                    );
                    Assert.Equal(
                        secret,
                        schema["properties"]![secret]!["enum"]![0]!.GetValue<string>()
                    );
                    var history = body[
                        protocol == "openai-responses" ? "input" : "messages"
                    ]!.ToJsonString();
                    Assert.Contains(key, history);
                    Assert.Contains(opaque, history);
                    if (protocol == "openai-responses")
                    {
                        var input = body["input"]!.AsArray().OfType<JsonObject>().ToArray();
                        var call = input.Single(item =>
                            SessionWait.Text(item["type"]) == "function_call"
                        );
                        Assert.Equal(
                            key,
                            JsonNode.Parse(call["arguments"]!.GetValue<string>())![
                                "value"
                            ]!.GetValue<string>()
                        );
                        Assert.Equal(
                            key,
                            input.Single(item =>
                                SessionWait.Text(item["type"]) == "function_call_output"
                            )["output"]!.GetValue<string>()
                        );
                    }
                    else if (protocol == "openai-completions")
                    {
                        var messages = body["messages"]!.AsArray().OfType<JsonObject>().ToArray();
                        var call = messages.Single(item => item["tool_calls"] is not null)[
                            "tool_calls"
                        ]![0]!["function"]!;
                        Assert.Equal(
                            key,
                            JsonNode.Parse(call["arguments"]!.GetValue<string>())![
                                "value"
                            ]!.GetValue<string>()
                        );
                        Assert.Equal(
                            key,
                            messages.Single(item => SessionWait.Text(item["role"]) == "tool")[
                                "content"
                            ]!.GetValue<string>()
                        );
                    }
                    else
                    {
                        var blocks = body["messages"]!
                            .AsArray()
                            .SelectMany(message => message?["content"] as JsonArray ?? [])
                            .OfType<JsonObject>()
                            .ToArray();
                        Assert.Equal(
                            key,
                            blocks.Single(block => SessionWait.Text(block["type"]) == "tool_use")[
                                "input"
                            ]!["value"]!.GetValue<string>()
                        );
                        Assert.Equal(
                            key,
                            blocks.Single(block =>
                                SessionWait.Text(block["type"]) == "tool_result"
                            )["content"]!.GetValue<string>()
                        );
                    }
                    var wire = Response(protocol, stream, key, opaque);
                    await LoopbackResponsesServer.WriteResponseAsync(
                        connection,
                        200,
                        stream ? "text/event-stream" : "application/json",
                        Encoding.UTF8.GetBytes(wire),
                        7,
                        31,
                        3
                    );
                }
                catch (Exception error)
                {
                    peerFailure = error;
                    throw;
                }
            }
        );
        var root = JsonNode
            .Parse(
                """
                {"providers":{"p":{"models":["m"],"extraFields":{"opaque":"opaque-only"},"extraHeaders":{"X-Opaque":"opaque-only"}}}}
                """
            )!
            .AsObject();
        var provider = root["providers"]!["p"]!;
        provider["providerType"] = protocol;
        provider["baseUrl"] = peer.BaseUri.ToString();
        provider["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint);
        provider["extraFields"]!["stream"] = stream;
        var catalog = HostModels.Parse(root, new());
        var historyRows = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = secret }),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["__meta"] = new JsonObject { ["modelId"] = "p/m" },
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["thinking"] = opaque,
                        ["providerMeta"] = new JsonObject
                        {
                            ["signature"] = opaque,
                            ["encryptedThinking"] = opaque,
                            ["thinkingSummaries"] = new JsonArray(opaque),
                            ["redactedThinking"] = opaque,
                        },
                    },
                    new JsonObject { ["text"] = secret },
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "history-call",
                            ["name"] = secret,
                            ["args"] = new JsonObject { ["value"] = secret },
                            ["rawArgsText"] = new JsonObject { ["value"] = secret }.ToJsonString(),
                        },
                    }
                ),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "history-call",
                            ["name"] = secret,
                            ["response"] = new JsonObject { ["output"] = secret },
                        },
                    }
                ),
            },
        };
        var original = new JsonArray(historyRows.Select(row => row.DeepClone()).ToArray());
        var tools = new JsonArray(
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = secret,
                ["description"] = secret,
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["required"] = new JsonArray(secret),
                    ["examples"] = new JsonArray(new JsonObject { ["description"] = secret }),
                    ["properties"] = new JsonObject
                    {
                        [secret] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] = secret,
                            ["enum"] = new JsonArray(secret),
                        },
                    },
                },
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        var owner = new ModelRequestOwner(
            http,
            new(peer.BaseUri, "m", "p/m", "", "", 100, tools),
            new()
        );
        var updates = new List<ResponsesStreamProgress>();
        var pending = owner.RequestAsync(
            "s",
            owner.Capture(catalog, "p/m", null),
            "cache",
            "turn",
            historyRows,
            (_, _) => Task.FromResult(secret),
            null,
            null,
            (_, value) => updates.Add(value),
            null,
            default,
            maxAttempts: 1
        );
        ChatResult result;
        try
        {
            result = await pending;
        }
        catch
        {
            Assert.Null(peerFailure);
            throw;
        }
        Assert.True(
            JsonNode.DeepEquals(
                original,
                new JsonArray(historyRows.Select(row => row.DeepClone()).ToArray())
            )
        );
        Assert.Equal(secret, tools[0]!["description"]!.GetValue<string>());
        var parts = result.AssistantMessage!["parts"]!.AsArray();
        Assert.Contains(parts, part => SessionWait.Text(part?["text"]) == secret);
        Assert.Contains(parts, part => SessionWait.Text(part?["thinking"]) == key);
        Assert.Equal(
            secret,
            parts.Single(part => part?["functionCall"] is not null)!["functionCall"]!["args"]![
                "value"
            ]!.GetValue<string>()
        );
        Assert.DoesNotContain(opaque, detector.Texts);
        if (stream && protocol != "openai-responses")
        {
            Assert.Contains(updates, value => value.Text == secret);
            Assert.Contains(updates, value => value.Reasoning == key);
            Assert.Contains(
                updates,
                value =>
                    value.ToolCalls.Any(call =>
                        call.Arguments is string args
                        && JsonNode.Parse(args)?["value"]?.GetValue<string>() == secret
                    )
            );
        }
    }

    private static string Response(string protocol, bool stream, string key, string opaque)
    {
        string Event(JsonObject value) => "data: " + value.ToJsonString() + "\n\n";
        var args = new JsonObject { ["value"] = key };
        if (protocol == "openai-completions")
        {
            var delta = new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = key,
                ["reasoning_content"] = key,
                ["tool_calls"] = new JsonArray(
                    new JsonObject
                    {
                        ["index"] = 0,
                        ["id"] = "call",
                        ["type"] = "function",
                        ["function"] = new JsonObject
                        {
                            ["name"] = "echo",
                            ["arguments"] = args.ToJsonString(),
                        },
                    }
                ),
            };
            return Event(
                    new JsonObject
                    {
                        ["choices"] = new JsonArray(
                            new JsonObject { ["delta"] = delta, ["finish_reason"] = "tool_calls" }
                        ),
                    }
                ) + "data: [DONE]\n\n";
        }
        if (protocol == "openai-responses")
            return Event(
                new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "reasoning",
                                ["summary"] = new JsonArray(new JsonObject { ["text"] = key }),
                                ["encrypted_content"] = opaque,
                            },
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = key }
                                ),
                            },
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["call_id"] = "call",
                                ["name"] = "echo",
                                ["arguments"] = args.ToJsonString(),
                            }
                        ),
                    },
                }
            );
        var blocks = new JsonArray(
            new JsonObject
            {
                ["type"] = "thinking",
                ["thinking"] = key,
                ["signature"] = opaque,
            },
            new JsonObject { ["type"] = "redacted_thinking", ["data"] = opaque },
            new JsonObject { ["type"] = "text", ["text"] = key },
            new JsonObject
            {
                ["type"] = "tool_use",
                ["id"] = "call",
                ["name"] = "echo",
                ["input"] = args,
            }
        );
        if (!stream)
            return new JsonObject
            {
                ["content"] = blocks,
                ["stop_reason"] = "tool_use",
            }.ToJsonString();
        var output = Event(
            new JsonObject
            {
                ["type"] = "message_start",
                ["message"] = new JsonObject { ["id"] = "message", ["usage"] = new JsonObject() },
            }
        );
        for (var index = 0; index < blocks.Count; index++)
        {
            output += Event(
                new JsonObject
                {
                    ["type"] = "content_block_start",
                    ["index"] = index,
                    ["content_block"] = blocks[index]!.DeepClone(),
                }
            );
            if (index == 3)
                output += Event(
                    new JsonObject
                    {
                        ["type"] = "content_block_delta",
                        ["index"] = index,
                        ["delta"] = new JsonObject
                        {
                            ["type"] = "input_json_delta",
                            ["partial_json"] = args.ToJsonString(),
                        },
                    }
                );
            output += Event(new JsonObject { ["type"] = "content_block_stop", ["index"] = index });
        }
        output += Event(
            new JsonObject
            {
                ["type"] = "message_delta",
                ["delta"] = new JsonObject { ["stop_reason"] = "tool_use" },
            }
        );
        return output + Event(new JsonObject { ["type"] = "message_stop" });
    }
}
