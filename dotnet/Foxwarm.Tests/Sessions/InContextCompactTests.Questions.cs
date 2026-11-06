using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    [Fact]
    public async Task Open_question_remains_answerable_after_its_tool_call_is_compacted()
    {
        await using var fixture = await Fixture.CreateAsync(
            3,
            (f, index, _) =>
            {
                f.InputTokens = index == 1 ? 21000 : 50;
                return Task.FromResult(
                    index switch
                    {
                        0 => new JsonArray(
                            Call(
                                "ask",
                                "ask_user",
                                new JsonObject
                                {
                                    ["questions"] = new JsonArray(
                                        new JsonObject { ["question"] = "Ship on Friday?" }
                                    ),
                                    ["afterAsk"] = "continue",
                                }
                            )
                        ),
                        1 => new JsonArray(Call("plan", "submit_compact_plan", Plan(2, 6))),
                        _ => Final(),
                    }
                );
            }
        );
        await fixture.RunAsync();
        Assert.Null(fixture.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(3, fixture.Peer.RequestCount);
        Assert.True(
            SessionWait.Text(fixture.ToolResponse("plan")["response"]?["applied"]) is null
                || fixture.ToolResponse("plan")["response"]!["applied"]!.GetValue<bool>()
        );
        Assert.DoesNotContain(
            fixture.Owner.History(),
            row =>
                row["parts"]!
                    .AsArray()
                    .Any(part => SessionWait.Text(part?["functionCall"]?["name"]) == "ask_user")
        );
        var view = fixture.Manager.QuestionsView(fixture.Owner);
        var question = view["questions"]!.AsArray().Single()!;
        Assert.Equal("open", SessionWait.Text(question["status"]));
        Assert.Equal("Ship on Friday?", SessionWait.Text(question["questions"]![0]!["question"]));
        Assert.Contains("question-reminder", fixture.Requests[2]["input"]!.ToJsonString());
        var id = SessionWait.Text(question["id"])!;
        await fixture.Manager.AnswerQuestionAsync(
            fixture.Owner,
            id,
            new JsonObject { ["answers"] = new JsonArray(new JsonObject { ["text"] = "Yes" }) }
        );
        Assert.Equal(
            "answered",
            SessionQuestions.Status(SessionQuestions.Find(fixture.Owner.Entry.Snapshot().Meta, id)!)
        );
    }
}
