using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    private static string AnthropicReply(
        int index,
        string? name,
        string? id,
        JsonObject? args,
        string reason
    )
    {
        static string Event(JsonObject value) => "data: " + value.ToJsonString() + "\n\n";
        var result = Event(
            new JsonObject
            {
                ["type"] = "message_start",
                ["message"] = new JsonObject
                {
                    ["id"] = "truncated-exchange-" + index,
                    ["usage"] = new JsonObject { ["input_tokens"] = 40, ["output_tokens"] = 1 },
                },
            }
        );
        result += Event(
            new JsonObject
            {
                ["type"] = "content_block_start",
                ["index"] = 0,
                ["content_block"] = name is null
                    ? new JsonObject { ["type"] = "text", ["text"] = "Done." }
                    : new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = id,
                        ["name"] = name,
                        ["input"] = new JsonObject(),
                    },
            }
        );
        if (name is not null)
            result += Event(
                new JsonObject
                {
                    ["type"] = "content_block_delta",
                    ["index"] = 0,
                    ["delta"] = new JsonObject
                    {
                        ["type"] = "input_json_delta",
                        ["partial_json"] = args!.ToJsonString(),
                    },
                }
            );
        result += Event(new JsonObject { ["type"] = "content_block_stop", ["index"] = 0 });
        result += Event(
            new JsonObject
            {
                ["type"] = "message_delta",
                ["delta"] = new JsonObject { ["stop_reason"] = reason },
                ["usage"] = new JsonObject { ["output_tokens"] = 7 },
            }
        );
        return result + Event(new JsonObject { ["type"] = "message_stop" });
    }

    [Theory]
    [InlineData("call-only")]
    [InlineData("response-only")]
    [InlineData("whole-exchange")]
    [InlineData("preserve-exchange")]
    [InlineData("other-source")]
    public async Task Anthropic_truncated_complete_tool_exchange_is_atomic_through_compaction_and_the_next_request(
        string selection
    )
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var file = Path.Combine(work, "observed.txt");
        await File.WriteAllTextAsync(file, "Successful original read result.");
        SessionOwner owner = null!;
        string? notice = null;
        string? noticeParts = null;
        await using var peer = new ScriptedResponsesSequenceServer(
            selection == "preserve-exchange" ? 4 : 3,
            async (index, stream, captured) =>
            {
                string output;
                if (index == 0)
                    output = AnthropicReply(
                        index,
                        "read",
                        "original-read",
                        new JsonObject { ["filePath"] = file },
                        "max_tokens"
                    );
                else if (index == 1)
                {
                    var rows = owner.History();
                    Assert.Equal(
                        new long[] { 1, 2, 3, 4 },
                        rows.Select(row =>
                            CompactCandidateBuilder.Number(row["__meta"]?["seq"])!.Value
                        )
                    );
                    var call = rows[1]["parts"]![0]!["functionCall"]!;
                    Assert.Equal("original-read", call["id"]!.GetValue<string>());
                    Assert.False(CompactCandidateBuilder.Visible(rows[2]));
                    Assert.Equal(
                        "max_tokens",
                        rows[2]["__meta"]!["stopReason"]!.GetValue<string>()
                    );
                    Assert.Equal(
                        "original-read",
                        rows[3]["parts"]![0]!["functionResponse"]![
                            "tool_use_id"
                        ]!.GetValue<string>()
                    );
                    notice = rows[2].ToJsonString();
                    noticeParts = rows[2]["parts"]!.ToJsonString();
                    var exchange = Assert.Single(
                        CompactCandidateBuilder.Build(rows, inContext: true).Items,
                        candidate => candidate.Start == 2
                    );
                    Assert.Equal(4, exchange.End);
                    Assert.Equal(1, CompactCandidateBuilder.Split(rows, .25));
                    Assert.Equal(1, CompactCandidateBuilder.Split(rows, .5));
                    var args = selection switch
                    {
                        "call-only" => Plan(2),
                        "response-only" => Plan(4),
                        "other-source" => Plan(1),
                        _ => Plan(2, 4),
                    };
                    if (selection == "preserve-exchange")
                        args["preserveMessages"] = new JsonArray(4);
                    output = AnthropicReply(
                        index,
                        "submit_compact_plan",
                        "select",
                        args,
                        "tool_use"
                    );
                }
                else
                {
                    var input = JsonNode.Parse(captured.Body)!["messages"]!.ToJsonString();
                    Assert.DoesNotContain("Tool output is lost", input);
                    if (selection != "whole-exchange" && index == 2)
                    {
                        Assert.Contains("original-read", input);
                        Assert.Contains("Successful original read result.", input);
                    }
                    else
                        Assert.DoesNotContain("original-read", input);
                    if (selection == "preserve-exchange" && index == 2)
                    {
                        var candidates = CompactCandidateBuilder.Build(
                            owner.History(),
                            inContext: true
                        );
                        Assert.Equal(
                            new long[] { 2, 4 },
                            candidates.Preserved.Single(item => item.Seq == 2).Exchange
                        );
                        var remove = new JsonObject
                        {
                            ["inContext"] = true,
                            ["replaceAsBlocks"] = new JsonArray(),
                            ["removePreservedMessages"] = new JsonArray(4),
                        };
                        Assert.Throws<CompactPlanInvalidException>(() =>
                            CompactPlanValidator.Validate(remove, candidates)
                        );
                        remove["removePreservedMessages"] = new JsonArray(2, 4);
                        output = AnthropicReply(
                            index,
                            "submit_compact_plan",
                            "remove-preserved",
                            remove,
                            "tool_use"
                        );
                    }
                    else
                        output = AnthropicReply(index, null, null, null, "end_turn");
                }
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(output)
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 713);
        var models = HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 20000,
                        ["asyncCompact"] = false,
                    },
                },
            },
            new JsonObject()
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            work,
            options,
            models,
            Path.Combine(temp.Path, "skills")
        );
        await manager.LoadMainHostAsync();
        owner = await manager.CreateNamedAsync("main", "truncated", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("Keep the completed exchange intact.")
        );
        await owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(selection == "preserve-exchange" ? 4 : 3, peer.RequestCount);
        var rejected = selection is "call-only" or "response-only";
        var receipt = owner
            .History()
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part?["functionResponse"])
            .OfType<JsonObject>()
            .Single(response => SessionWait.Text(response["tool_use_id"]) == "select")["response"]!;
        Assert.Equal(rejected, receipt["error"] is not null);
        Assert.Equal(
            rejected ? 0
                : selection == "preserve-exchange" ? 2
                : 1,
            owner.Entry.Snapshot().HistoryVersion
        );
        if (selection != "whole-exchange")
            Assert.Contains(
                owner.History(),
                row =>
                    selection == "preserve-exchange"
                        ? CompactCandidateBuilder.Number(row["__meta"]?["seq"]) == 3
                            && row["parts"]!.ToJsonString() == noticeParts
                        : row.ToJsonString() == notice
            );
        if (selection == "preserve-exchange")
            Assert.DoesNotContain(
                owner.History(),
                row => CompactCandidateBuilder.Number(row["__meta"]?["seq"]) is 2 or 4
            );
        Assert.Contains(
            owner.Archive.ReadMessages(),
            row => row.Seq == 4 && row.MessageJson.Contains("Successful original read result.")
        );
    }
}
