using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class SessionSequencePagingTests
{
    private const long Minute = 60_000;
    private const long Day = 24 * 60 * Minute;

    private static IEnumerable<JsonObject> Objects(JsonNode? array) =>
        (array as JsonArray)?.OfType<JsonObject>() ?? [];

    private static string? Text(JsonNode? node) => SessionWait.Text(node);

    private static double? Number(JsonNode? node) => SessionWait.Number(node);

    private static JsonObject User(long at, string text) =>
        new()
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject { ["timestamp"] = at },
        };

    private static JsonObject Model(long at, string text) =>
        new()
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject
            {
                ["timestamp"] = at,
                ["llmRequestTiming"] = new JsonObject
                {
                    ["startedAt"] = at - 50,
                    ["completedAt"] = at,
                },
            },
        };

    // The catalog's last-message time follows the clock of the append that carries input.
    private static Task Append(
        SessionOwner owner,
        long clock,
        bool input,
        params JsonObject[] messages
    ) =>
        owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                messages,
                [],
                updateLastMessageTime: input,
                finalizing: false,
                () => clock
            )
        );

    private static string WrapperTime(long at) =>
        DateTimeOffset
            .FromUnixTimeMilliseconds(at)
            .ToOffset(TimeSpan.FromHours(8))
            .ToString("yyyy-MM-dd HH:mm:ss +0800", CultureInfo.InvariantCulture);

    private sealed record Fixture(
        ScriptFixture Scripts,
        SessionSequenceProjection Projection,
        SessionOwner Idle,
        SessionOwner Sender,
        SessionOwner Receiver,
        SessionOwner LongTurn,
        SessionOwner Busy,
        long Base
    ) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => Scripts.DisposeAsync();
    }

    private static async Task<Fixture> Create()
    {
        var f = await ScriptFixture.Create();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var start = (now - 3 * Day) / Minute * Minute;
        var idle = f.Owner;
        var sender = await f.Manager.CreateNamedAsync("main", "sender", null, null);
        var receiver = await f.Manager.CreateNamedAsync("main", "receiver", null, null);
        var longTurn = await f.Manager.CreateNamedAsync("main", "long-turn", null, null);
        var busy = await f.Manager.CreateNamedAsync("main", "busy", null, null);

        // A long-lived Session: one row three days ago and one a minute ago, nothing between.
        await Append(idle, start + 5_000, true, User(start + 5_000, "ancient"));
        await Append(idle, now - Minute, true, User(now - Minute, "recent"));

        // An exact delivery: sent at day 2 + 30 s, read five minutes later.
        var sent = start + 2 * Day + 30_000;
        await Append(
            sender,
            sent - 1_000,
            true,
            User(sent - 1_000, "go"),
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "s1",
                            ["name"] = "send_to_session",
                            ["args"] = new JsonObject
                            {
                                ["sessionId"] = receiver.Id,
                                ["message"] = "paged hello",
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = sent - 10 },
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "s1",
                            ["name"] = "send_to_session",
                            ["response"] = new JsonObject { ["output"] = "sent" },
                            ["executionTiming"] = new JsonObject
                            {
                                ["startedAt"] = sent,
                                ["completedAt"] = sent + 5,
                            },
                            ["__meta"] = new JsonObject
                            {
                                ["sessionMessages"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["targetSessionId"] = receiver.Id,
                                        ["message"] = "paged hello",
                                        ["deliverySeq"] = "2.1",
                                    }
                                ),
                            },
                        },
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = sent + 5 },
            }
        );
        await Append(
            receiver,
            sent + 5 * Minute,
            true,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] =
                            $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{sender.Id}\" deliverySeq=\"2.1\" time=\"{WrapperTime(sent)}\" hint=\"inter-agent message\">\npaged hello\n</foxwarm-message>",
                    }
                ),
                ["__meta"] = new JsonObject { ["timestamp"] = sent + 5 * Minute },
            },
            Model(sent + 5 * Minute + 500, "read it")
        );

        // A turn whose rows follow its input by half an hour; the catalog only knows the input.
        var turn = start + Day;
        await Append(longTurn, turn, true, User(turn, "long work"));
        await Append(
            longTurn,
            turn,
            false,
            Model(turn + 10 * Minute, "step one"),
            Model(turn + 20 * Minute, "step two"),
            Model(turn + 30 * Minute, "step three")
        );

        // Twenty rows inside one minute.
        var burst = start + 2 * Day + 10 * Minute;
        await Append(
            busy,
            burst,
            true,
            Enumerable
                .Range(0, 20)
                .Select(index => index == 0 ? User(burst, "burst") : Model(burst + index * 100, $"b{index}"))
                .ToArray()
        );

        var projection = new SessionSequenceProjection(
            new SessionRuntime(f.Manager),
            f.Manager.ArchiveDatabase
        );
        return new(f, projection, idle, sender, receiver, longTurn, busy, start);
    }

    private static List<JsonObject> Pages(SessionSequenceProjection projection, int limit)
    {
        var pages = new List<JsonObject>();
        ArchiveSequenceCursor? cursor = null;
        while (pages.Count < 200)
        {
            var page = projection.BuildPage(new(cursor, limit), null);
            pages.Add(page);
            if (page["hasMore"]?.GetValue<bool>() != true)
                return pages;
            var next = page["next"]!;
            cursor = new(
                Number(next["at"])!.Value,
                Text(next["sessionId"]),
                Number(next["seq"]) is { } seq ? (long)seq : null
            );
        }
        throw new InvalidOperationException("Paging did not finish.");
    }

    [Fact]
    public async Task Newest_first_pages_cover_every_row_once_and_end_on_minute_boundaries()
    {
        await using var f = await Create();
        var pages = Pages(f.Projection, 3);
        Assert.True(pages.Count > 4);

        // Every own row of every Session appears in exactly one page.
        var seen = new Dictionary<string, List<(long First, long Last)>>(StringComparer.Ordinal);
        var maxSeq = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var page in pages)
        foreach (var lane in Objects(page["sessions"]))
        {
            var id = Text(lane["id"])!;
            seen.TryAdd(id, []);
            seen[id].Add(((long)Number(lane["firstSeq"])!, (long)Number(lane["lastSeq"])!));
            maxSeq[id] = (long)Number(lane["maxSeq"])!;
        }
        foreach (var owner in new[] { f.Idle, f.Sender, f.Receiver, f.LongTurn, f.Busy })
        {
            var ranges = seen[owner.Id].OrderBy(range => range.First).ToArray();
            Assert.Equal(1, ranges[0].First);
            for (var index = 1; index < ranges.Length; index++)
                Assert.Equal(ranges[index - 1].Last + 1, ranges[index].First);
            Assert.Equal(maxSeq[owner.Id], ranges[^1].Last);
        }

        // Pages are contiguous and newest first; each ends on a minute boundary unless the
        // twenty-row minute had to be split with a row cursor.
        double? previousFrom = null;
        var split = 0;
        foreach (var page in pages)
        {
            var range = page["range"]!;
            var from = Number(range["from"])!.Value;
            if (previousFrom is double upper)
                Assert.Equal(upper, Number(range["to"]));
            else
                Assert.Null(range["to"]);
            if (page["next"]?["sessionId"] is not null)
                split++;
            else
                Assert.Equal(0, from % Minute);
            foreach (var item in Objects(page["events"]))
            {
                var at = Number(item["end"])!.Value;
                Assert.True(at >= from, $"{at} before page start {from}");
                if (previousFrom is double top)
                    Assert.True(at < top || page["next"]?["sessionId"] is not null || split > 0);
            }
            previousFrom = from;
        }
        Assert.True(split > 0, "the burst minute exceeds four times the page limit");

        // A larger limit keeps the burst minute whole.
        var whole = Pages(f.Projection, 10);
        Assert.All(whole, page => Assert.Null(page["next"]?["sessionId"]));
        var burstPages = whole
            .Where(page => Objects(page["events"]).Any(item => Text(item["sessionId"]) == f.Busy.Id))
            .ToArray();
        Assert.Single(burstPages);
        Assert.Equal(19, Objects(burstPages[0]["events"]).Count(item => Text(item["sessionId"]) == f.Busy.Id));

        // Rows after the catalog's last-message time still place the Session at those times.
        var steps = whole
            .SelectMany(page => Objects(page["events"]))
            .Where(item => Text(item["sessionId"]) == f.LongTurn.Id)
            .Select(item => Text(item["preview"]))
            .ToArray();
        Assert.Equal(new[] { "step one", "step three", "step two" }, steps.Order());

        // The first page starts at the newest row; the idle Session's old row comes last.
        Assert.Contains(Objects(pages[0]["links"]), link => Text(link["preview"]) == "recent");
        var last = whole[^1];
        Assert.False(last["hasMore"]!.GetValue<bool>());
        Assert.Contains(Objects(last["links"]), link => Text(link["preview"]) == "ancient");
        Assert.Equal(f.Base + 5_000, Number(Objects(last["sessions"]).Single(row => Text(row["id"]) == f.Idle.Id)["createdAt"]));
    }

    [Fact]
    public async Task A_delivery_split_across_pages_has_one_key_and_marks_the_older_half_pending()
    {
        await using var f = await Create();
        var pages = Pages(f.Projection, 1);
        var halves = pages
            .Select((page, index) => (index, links: Objects(page["links"]).Where(link => Text(link["deliverySeq"]) == "2.1").ToArray()))
            .Where(item => item.links.Length > 0)
            .ToArray();
        Assert.Equal(2, halves.Length);
        var received = halves[0].links.Single();
        var sent = halves[1].links.Single();
        Assert.True(halves[0].index < halves[1].index, "the receiving page is newer");
        Assert.Equal(Text(received["key"]), Text(sent["key"]));
        Assert.Equal("older", Text(received["pending"]));
        Assert.Equal("exact", Text(received["pairing"]));
        Assert.NotNull(received["consumedAt"]);
        Assert.Equal(f.Sender.Id, Text(sent["from"]!["sessionId"]));
        Assert.Equal("queued", Text(sent["state"]));
        Assert.Null(sent["pending"]);

        // One page holding both halves pairs them directly.
        var both = Pages(f.Projection, 50);
        var paired = both.SelectMany(page => Objects(page["links"])).Where(link => Text(link["deliverySeq"]) == "2.1").ToArray();
        var single = Assert.Single(paired);
        Assert.Null(single["pending"]);
        Assert.Null(single["state"]);
    }

    [Fact]
    public async Task Live_updates_read_after_known_cursors_and_find_newly_active_Sessions()
    {
        await using var f = await Create();
        var newest = f.Projection.BuildPage(new(), null);
        var cursors = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var (id, seq) in newest["cursors"]!.AsObject())
            cursors[id] = (long)Number(seq)!;
        var since = Number(newest["generatedAt"])!.Value - 5_000;
        Assert.Empty(Objects(f.Projection.BuildIncremental(new(since, cursors), null)["events"]));

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await Append(f.Idle, now, true, User(now, "again"), Model(now + 10, "answer"));
        await Append(f.Sender, now, true, User(now, "wake"), Model(now + 20, "awake"));
        var delta = f.Projection.BuildIncremental(new(since, cursors), null);
        Assert.Equal("incremental", Text(delta["mode"]));
        Assert.Equal(
            new[] { "answer", "awake" },
            Objects(delta["events"]).Select(item => Text(item["preview"])).Order()
        );
        Assert.True(Number(delta["cursors"]![f.Idle.Id]) > cursors[f.Idle.Id]);
        Assert.Contains(Objects(delta["sessions"]), row => Text(row["id"]) == f.Sender.Id);
    }
}
