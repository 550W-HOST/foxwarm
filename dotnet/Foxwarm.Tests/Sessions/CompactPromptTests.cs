using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactPromptTests
{
    private const string Header = "Current status of Tasks mentioned in the sources:";

    private static JsonObject Row(string role, long seq, string text) =>
        new()
        {
            ["role"] = role,
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
        };

    private static JsonObject BlockRow(long id, string summary, JsonArray? facts = null)
    {
        var raw = id * 10;
        return new ArchiveBlockRecord(
            "prompt",
            "main",
            id,
            1,
            "message",
            raw + 1,
            raw + 10,
            null,
            raw + 1,
            raw + 10,
            null,
            null,
            SessionCompactor.FormatSummary(summary, facts),
            facts,
            1
        ).ToMessage();
    }

    // Four level-1 blocks overflow level 1: B#1 and B#2 merge, and raw messages 500.. are the new
    // level-1 block's sources.
    private static CompactCandidates Candidates(
        string[] summaries,
        string[] raw,
        string? factText = null
    )
    {
        var rows = new List<JsonObject>();
        for (var index = 0; index < summaries.Length; index++)
            rows.Add(
                BlockRow(
                    index + 1,
                    summaries[index],
                    index == 1 && factText is not null
                        ? new JsonArray(new JsonObject { ["kind"] = "fact", ["text"] = factText })
                        : null
                )
            );
        for (var index = 0; index < raw.Length; index++)
            rows.Add(Row(index % 2 == 0 ? "user" : "model", 500 + index, raw[index]));
        return CompactCandidateBuilder.Build(rows, keepTokens: 0);
    }

    private static string Id(int n) => $"task_{n:x12}";

    private static string Padded(string tail) => new string('x', 8000) + " " + tail;

    private static string[] Lines(string prompt) => prompt.Split('\n');

    private static IReadOnlyDictionary<string, string> Known(
        IReadOnlyList<string> ids,
        Dictionary<string, string> statuses
    ) => ids.Where(statuses.ContainsKey).ToDictionary(id => id, id => statuses[id]);

    [Fact]
    public void Section_lists_statuses_in_order_of_first_occurrence_after_the_operations()
    {
        var candidates = Candidates(
            ["one " + Id(2), "two", "three", "four " + Id(8)],
            [Padded("raw " + Id(3)), "reply " + Id(2) + " " + Id(1) + " " + Id(9)],
            "fact mentions " + Id(6)
        );
        Assert.NotEmpty(candidates.Retention);
        IReadOnlyList<string>? requested = null;
        var statuses = new Dictionary<string, string>
        {
            [Id(1)] = "completed",
            [Id(2)] = "open",
            [Id(3)] = "cancelled",
            [Id(6)] = "active",
            [Id(8)] = "open",
        };
        var prompt = CompactPrompt.Build(
            candidates,
            null,
            ids =>
            {
                requested = ids;
                return Known(ids, statuses);
            }
        );
        // Operations are listed oldest first: the merge sources (B#1, B#2 with its facts), then
        // the raw messages. Id(8) is in a block that no operation sources; Id(9) is unknown.
        Assert.Equal([Id(2), Id(6), Id(3), Id(1), Id(9)], requested);
        var lines = Lines(prompt);
        var header = Array.IndexOf(lines, Header);
        Assert.True(header > 0);
        Assert.Equal(
            [
                $"- {Id(2)}: open",
                $"- {Id(6)}: active",
                $"- {Id(3)}: cancelled",
                $"- {Id(1)}: completed",
            ],
            lines.Skip(header + 1).Take(4)
        );
        Assert.Equal("", lines[header - 1]);
        Assert.Equal("", lines[header + 5]);
        Assert.DoesNotContain($"- {Id(9)}", prompt);
        // Right after the required-operations list, before the writing instructions.
        var lastOperation = Array.FindLastIndex(lines, line => line.StartsWith("- M#"));
        Assert.True(lastOperation < header);
        Assert.True(header < Array.IndexOf(lines, "Rules:"));
    }

    [Fact]
    public void Raw_message_ids_are_found_beyond_the_shortened_candidate_preview()
    {
        var candidates = Candidates(["a", "b", "c", "d"], [Padded("late " + Id(4)), "end"]);
        Assert.DoesNotContain(Id(4), CompactPrompt.Build(candidates));
        var prompt = CompactPrompt.Build(
            candidates,
            null,
            ids => Known(ids, new() { [Id(4)] = "open" })
        );
        Assert.Contains($"{Header}\n- {Id(4)}: open\n", prompt);
    }

    [Fact]
    public void Section_is_omitted_without_a_known_task()
    {
        var candidates = Candidates(["one " + Id(2), "b", "c", "d"], ["raw", "reply"]);
        var none = CompactPrompt.Build(candidates, null, ids => Known(ids, new()));
        Assert.DoesNotContain(Header, none);
        Assert.Equal(CompactPrompt.Build(candidates), none);
        var noIds = Candidates(["a", "b", "c", "d"], [Padded("no ids"), "end"]);
        var called = false;
        var withoutIds = CompactPrompt.Build(
            noIds,
            null,
            ids =>
            {
                called = true;
                return Known(ids, new() { [Id(2)] = "open" });
            }
        );
        Assert.False(called);
        Assert.DoesNotContain(Header, withoutIds);
    }

    [Fact]
    public void Ids_outside_the_sources_are_not_looked_up()
    {
        var candidates = Candidates(["a", "b", "c", "d"], [Padded("source " + Id(1)), "end"]);
        IReadOnlyList<string>? requested = null;
        CompactPrompt.Build(
            candidates,
            "requester guidance names " + Id(7),
            ids =>
            {
                requested = ids;
                return Known(ids, new());
            }
        );
        Assert.Equal([Id(1)], requested);
        var inContext = CompactCandidateBuilder.Build(
            new List<JsonObject> { Row("user", 1, Padded(Id(1))), Row("model", 2, "ok") },
            inContext: true
        );
        var asked = false;
        CompactPrompt.Build(
            inContext,
            null,
            ids =>
            {
                asked = true;
                return Known(ids, new() { [Id(1)] = "open" });
            }
        );
        Assert.False(asked);
    }

    [Fact]
    public void Section_is_capped_at_one_hundred_lines()
    {
        var mentioned = string.Join(' ', Enumerable.Range(1, 130).Select(Id));
        var candidates = Candidates(["a", "b", "c", "d"], [Padded(mentioned), "end"]);
        // Unknown IDs do not use the cap: every fifth ID is unknown, so 104 are known.
        var statuses = Enumerable
            .Range(1, 130)
            .Where(n => n % 5 != 0)
            .ToDictionary(Id, _ => "completed");
        var lines = Lines(CompactPrompt.Build(candidates, null, ids => Known(ids, statuses)));
        var header = Array.IndexOf(lines, Header);
        var section = lines
            .Skip(header + 1)
            .TakeWhile(line => line.StartsWith("- task_"))
            .ToArray();
        Assert.Equal(100, section.Length);
        Assert.Equal($"- {Id(1)}: completed", section[0]);
        Assert.Equal($"- {Id(124)}: completed", section[^1]);
    }

    [Fact]
    public void Guidance_tells_the_planner_how_to_use_the_section()
    {
        var prompt = CompactPrompt.Build(Candidates(["a", "b", "c", "d"], [Padded("x"), "end"]));
        Assert.Contains(
            "unless a later source shows it finished. The current status of Tasks mentioned in the sources is listed after the operations. A Task shown there as completed or cancelled is finished: don't carry it forward as open, and keep one line for its outcome only if it still matters. Keep user decisions together with their msg# reference.",
            prompt
        );
    }

    [Fact]
    public void Store_lookup_returns_statuses_only_and_skips_unknown_ids()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-prompt-" + Guid.NewGuid().ToString("N")
        );
        Directory.CreateDirectory(root);
        try
        {
            using var store = new TaskStore(root, id => id, _ => []);
            Assert.Empty(store.Statuses([Id(1)]));
            string Create(string title)
            {
                var created = store.Execute(
                    new JsonObject { ["action"] = "create", ["title"] = title },
                    "owner"
                );
                return created.Payload["task"]!["id"]!.GetValue<string>();
            }
            var open = Create("SECRET-OPEN-TITLE");
            var active = Create("SECRET-ACTIVE-TITLE");
            var done = Create("SECRET-DONE-TITLE");
            var cancelled = Create("SECRET-CANCELLED-TITLE");
            store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = active }, "owner");
            store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = done }, "owner");
            store.Execute(new JsonObject { ["action"] = "complete", ["taskId"] = done }, "owner");
            store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = cancelled }, "owner");
            store.Execute(
                new JsonObject { ["action"] = "cancel", ["taskId"] = cancelled },
                "owner"
            );

            var candidates = Candidates(
                ["a " + done, "b", "c", "d"],
                [Padded($"{cancelled} {open} {active} {Id(5)}"), "end"]
            );
            var prompt = CompactPrompt.Build(candidates, null, store.Statuses);
            Assert.Contains(
                $"{Header}\n- {done}: completed\n- {cancelled}: cancelled\n- {open}: open\n- {active}: active\n\n",
                prompt
            );
            Assert.DoesNotContain("SECRET", prompt);
            Assert.DoesNotContain($"- {Id(5)}", prompt);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
