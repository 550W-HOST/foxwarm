using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionObservabilityTests
{
    private static JsonObject[] Ranges(JsonObject view, int slot = 0) =>
        view["slots"]![slot]!["ranges"]!.AsArray().Select(range => range!.AsObject()).ToArray();

    private static (int, int, string, string) Range(JsonObject range) =>
        (
            range["start"]!.GetValue<int>(),
            range["length"]!.GetValue<int>(),
            range["label"]!.GetValue<string>(),
            range["source"]!.GetValue<string>()
        );

    [Fact]
    public async Task Sent_version_comes_from_memory_and_reports_what_it_cannot_show()
    {
        await using var harness = await StartAsync();
        OnlyPhoneWhenRepeated(harness.Detector);
        var first = User("Hello " + Person + ", call " + Phone);
        var result = await harness.RequestAsync(first);
        var third = User(Phone + " then " + Person + " again");
        await harness.RequestAsync(first, result.AssistantMessage!, third);
        var calls = harness.Detector.Texts.Count;
        var candidates = TextRedactionView.Candidates(harness.Catalog, "p/m");
        Assert.Single(candidates);

        var view = TextRedactionView.Describe(first, candidates, harness.Keys.Secrets);
        Assert.Equal("available", view["state"]!.GetValue<string>());
        Assert.Equal("text", view["slots"]![0]!["kind"]!.GetValue<string>());
        Assert.Equal(
            first["parts"]![0]!["text"]!.GetValue<string>(),
            view["slots"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(
            [
                (6, Person.Length, "private_person", "detected"),
                (24, Phone.Length, "private_phone", "detected"),
            ],
            Ranges(view).Select(Range)
        );
        // A literal range after a detected one is mapped back to the stored text.
        var repeated = TextRedactionView.Describe(third, candidates, harness.Keys.Secrets);
        Assert.Equal(
            [
                (0, Phone.Length, "private_phone", "detected"),
                (17, Person.Length, "private_person", "literal"),
            ],
            Ranges(repeated).Select(Range)
        );
        var reply = TextRedactionView.Describe(
            result.AssistantMessage!,
            candidates,
            harness.Keys.Secrets
        );
        Assert.Equal("available", reply["state"]!.GetValue<string>());
        Assert.Empty(Ranges(reply));
        Assert.DoesNotContain(TextRedactor.Prefix, view.ToJsonString() + repeated.ToJsonString());
        // Rendering never asks the detector.
        Assert.Equal(calls, harness.Detector.Texts.Count);

        // Not sent, different settings, or a new process (an empty redactor): unavailable.
        Assert.Equal(
            "unavailable",
            TextRedactionView.Describe(User("never sent"), candidates, harness.Keys.Secrets)[
                "state"
            ]!.GetValue<string>()
        );
        var changed = new TextRedactionView.Candidate(
            candidates[0].Leaf,
            candidates[0].Options with
            {
                Threshold = 0.9,
            }
        );
        var stale = TextRedactionView.Describe(first, [changed], harness.Keys.Secrets);
        Assert.Equal("unavailable", stale["state"]!.GetValue<string>());
        Assert.False(stale["slots"]![0]!["available"]!.GetValue<bool>());
        Assert.Null(stale["slots"]![0]!["ranges"]);
        using var restarted = new TextRedactionKeys();
        Assert.Equal(
            "unavailable",
            TextRedactionView.Describe(first, candidates, restarted.Secrets)[
                "state"
            ]!.GetValue<string>()
        );
        Assert.False(
            TextRedactionView.Describe(first, [], harness.Keys.Secrets)["enabled"]!.GetValue<bool>()
        );
        Assert.Equal(calls, harness.Detector.Texts.Count);
    }

    [Fact]
    public async Task Slots_name_their_part_argument_path_and_tool()
    {
        var message = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                new JsonObject { ["text"] = "reply" },
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "c",
                        ["name"] = "exec",
                        ["args"] = new JsonObject
                        {
                            ["command"] = "echo",
                            ["items"] = new JsonArray("a", new JsonObject { ["name"] = "b" }),
                        },
                    },
                }
            ),
        };
        var result = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = "exec",
                        ["tool_use_id"] = "c",
                        ["response"] = new JsonObject { ["output"] = "done" },
                    },
                }
            ),
        };
        var slots = new List<TextSlot>();
        await TextRedactionProjection.RedactSlotsAsync(
            [message, result],
            (slot, text) =>
            {
                slots.Add(slot);
                return Task.FromResult(text);
            }
        );
        Assert.Equal(
            [
                new TextSlot(0, 0, "text"),
                new TextSlot(0, 1, "argument", "command", "exec", "c"),
                new TextSlot(0, 1, "argument", "items[0]", "exec", "c"),
                new TextSlot(0, 1, "argument", "items[1].name", "exec", "c"),
                new TextSlot(1, 0, "output", null, "exec", "c"),
            ],
            slots
        );
    }
}
