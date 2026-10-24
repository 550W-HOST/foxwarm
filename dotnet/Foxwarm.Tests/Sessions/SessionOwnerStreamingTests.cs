using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionOwnerStreamingTests
{
    private sealed class Clock : TimeProvider
    {
        internal long Milliseconds;
        internal readonly List<Timer> Timers = [];
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Milliseconds;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(Milliseconds);
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new Timer(this, callback, state);
            Timers.Add(timer);
            timer.Change(dueTime, period);
            return timer;
        }
        internal void Advance(long milliseconds)
        {
            var end = Milliseconds + milliseconds;
            while (Timers.Where(timer => timer.Due <= end).OrderBy(timer => timer.Due).FirstOrDefault() is { } next)
            {
                Milliseconds = next.Due;
                next.Due = long.MaxValue;
                next.Fire();
            }
            Milliseconds = end;
        }
        internal sealed class Timer(Clock clock, TimerCallback callback, object? state) : ITimer
        {
            internal long Due = long.MaxValue;
            internal void Fire() => callback(state); // A callback already queued at Dispose may still run.
            public bool Change(TimeSpan dueTime, TimeSpan period) { Due = dueTime == Timeout.InfiniteTimeSpan ? long.MaxValue : clock.Milliseconds + (long)dueTime.TotalMilliseconds; return true; }
            public void Dispose() => Due = long.MaxValue;
            public ValueTask DisposeAsync() { Dispose(); return default; }
        }
    }

    private static SessionOwner Owner(Clock clock)
    {
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "p/m", "", "", 100);
        var owner = new SessionOwner("s", "main", HostModels.ForTest(options), clock)
        {
            Registry = new SessionRegistry(new InMemorySessionAuthorityStore(), new FakeChatService()),
        };
        owner.Registry.Add("s");
        owner.EnableCommittedNotifications();
        return owner;
    }

    private static ResponsesStreamProgress Progress(string arguments, string text = "answer", bool ordered = true) => new(
        "summary", text, [new(1, "call", "read", arguments)],
        ordered ? [new(0, "reasoning", SummaryIndex: 0, Text: "summary"), new(1, "tool-call"), new(2, "text", Text: text, Phase: "final_answer")] : null);

    private static JsonObject[] Updates(List<(long At, SessionRuntimeEvent Event)> events) => events
        .Where(item => item.Event.Kind == SessionEventKind.ModelStream && SessionWait.Text(item.Event.Data?["type"]) == "model-stream-update")
        .Select(item => item.Event.Data!.AsObject()).ToArray();

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Arguments_have_fixed_one_second_cadence_while_identity_text_reasoning_and_bootstrap_stay_fast(bool ordered)
    {
        var clock = new Clock();
        var owner = Owner(clock);
        var events = new List<(long At, SessionRuntimeEvent Event)>();
        owner.Changed += value => events.Add((clock.Milliseconds, value));
        var stream = owner.BeginDraft("logical-request");
        owner.PublishDraftProgress(Progress("{", ordered: ordered));
        Assert.Empty(Updates(events));
        Assert.Equal("{", owner.DraftSnapshot()["toolCalls"]![0]!["arguments"]!.GetValue<string>());
        clock.Advance(80);
        var identity = Assert.Single(Updates(events));
        Assert.Equal("read", identity["toolCallDeltas"]![0]!["name"]!.GetValue<string>());
        Assert.Null(identity["toolCallDeltas"]![0]!["argumentsDelta"]);
        Assert.Equal("answer", identity["textDelta"]!["text"]!.GetValue<string>());
        Assert.Equal("summary", identity["reasoningDelta"]!["text"]!.GetValue<string>());
        for (var n = 1; n <= 8; n++)
        {
            clock.Advance(100);
            owner.PublishDraftProgress(Progress("{" + new string('x', n), "answer" + n, ordered));
        }
        Assert.DoesNotContain(Updates(events), frame => frame["toolCallDeltas"] is JsonArray calls && calls.Any(call => call?["argumentsDelta"] is not null));
        // A late subscriber sees all collected arguments, even though no argument delta has been sent.
        var snapshot = owner.DraftSnapshot();
        Assert.Equal("{xxxxxxxx", snapshot["toolCalls"]![0]!["arguments"]!.GetValue<string>());
        Assert.Equal(Updates(events).Last()["sequence"]!.GetValue<int>(), snapshot["sequence"]!.GetValue<int>());
        clock.Advance(120);
        var args = Updates(events).Last()["toolCallDeltas"]![0]!["argumentsDelta"]!;
        Assert.Equal(0, args["offset"]!.GetValue<int>());
        Assert.Equal("{xxxxxxxx", args["text"]!.GetValue<string>());
        owner.PublishDraftProgress(Progress("{xxxxxxxx}", "answer9", ordered));
        clock.Advance(999);
        Assert.Single(Updates(events), frame => frame["toolCallDeltas"] is JsonArray calls && calls.Any(call => call?["argumentsDelta"] is not null));
        clock.Advance(1);
        Assert.Equal("}", Updates(events).Last()["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        Assert.Equal(9, Updates(events).Last()["toolCallDeltas"]![0]!["argumentsDelta"]!["offset"]!.GetValue<int>());
        var sequences = Updates(events);
        Assert.Equal(Enumerable.Range(1, sequences.Length), sequences.Select(frame => frame["sequence"]!.GetValue<int>()));
        Assert.All(sequences, frame =>
        {
            Assert.Equal(stream, frame["streamId"]!.GetValue<string>());
            Assert.Equal("logical-request", frame["llmRequestId"]!.GetValue<string>());
            Assert.Equal(frame["sequence"]!.GetValue<int>(), frame["sequenceStart"]!.GetValue<int>());
        });
        owner.ClearDraft();
    }

    [Fact]
    public async Task Final_canonical_append_flushes_latest_arguments_before_message_and_cancels_future_callbacks()
    {
        var clock = new Clock();
        var owner = Owner(clock);
        var events = new List<(long At, SessionRuntimeEvent Event)>();
        owner.Changed += value => events.Add((clock.Milliseconds, value));
        owner.BeginDraft("request");
        owner.PublishDraftProgress(Progress("{\"filePath\":\"owned\"}"));
        clock.Advance(80);
        var oldTimers = clock.Timers.ToArray();
        await Append(owner, new JsonObject
        {
            ["role"] = "model", ["parts"] = new JsonArray(new JsonObject { ["text"] = "canonical" }),
            ["__meta"] = new JsonObject { ["llmRequestId"] = "request" },
        });
        var appendAt = events.FindIndex(item => item.Event.Kind == SessionEventKind.MessageCommitted);
        var argsAt = events.FindIndex(item => item.Event.Data?["toolCallDeltas"] is JsonArray calls && calls.Any(call => call?["argumentsDelta"] is not null));
        Assert.InRange(argsAt, 0, appendAt - 1);
        Assert.Equal("{\"filePath\":\"owned\"}", events[argsAt].Event.Data!["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        Assert.Empty(owner.DraftSnapshot());
        Assert.DoesNotContain(events.Skip(appendAt + 1), item => item.Event.Kind == SessionEventKind.ModelStream);
        var count = events.Count;
        foreach (var timer in oldTimers) timer.Fire();
        clock.Advance(5000);
        Assert.Equal(count, events.Count);
    }

    [Fact]
    public void Retry_reset_and_Stop_flush_and_fence_old_stream_timers_without_reviving_the_draft()
    {
        var clock = new Clock();
        var owner = Owner(clock);
        var events = new List<(long At, SessionRuntimeEvent Event)>();
        owner.Changed += value => events.Add((clock.Milliseconds, value));
        var old = owner.BeginDraft("request");
        owner.PublishDraftProgress(Progress("old-pending"));
        var staleTimers = clock.Timers.ToArray();
        owner.RestartDraft();
        var reset = events.Last().Event.Data!;
        Assert.NotEqual(old, reset["streamId"]!.GetValue<string>());
        Assert.Equal("request", reset["llmRequestId"]!.GetValue<string>());
        Assert.Equal("old-pending", Updates(events).Single()["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        owner.PublishDraftProgress(Progress("new-pending"));
        var count = events.Count;
        foreach (var timer in staleTimers) timer.Fire();
        Assert.Equal(count, events.Count);
        Assert.Equal("new-pending", owner.DraftSnapshot()["toolCalls"]![0]!["arguments"]!.GetValue<string>());
        owner.ClearDraft(); // RequestChatService's Stop/error cleanup uses this same boundary.
        var last = Updates(events).Last();
        Assert.Equal("new-pending", last["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        count = events.Count;
        foreach (var timer in clock.Timers) timer.Fire();
        clock.Advance(5000);
        Assert.Equal(count, events.Count);
        Assert.Empty(owner.DraftSnapshot());
    }

    [Fact]
    public void Commentary_trim_flushes_arguments_then_offsets_only_the_remaining_output_items()
    {
        var clock = new Clock();
        var owner = Owner(clock);
        var events = new List<(long At, SessionRuntimeEvent Event)>();
        owner.Changed += value => events.Add((clock.Milliseconds, value));
        owner.BeginDraft("request");
        owner.PublishDraftProgress(Progress("{", "visible"));
        clock.Advance(80);
        owner.ClearCommittedDraft(new JsonObject { ["__meta"] = new JsonObject
        {
            ["llmRequestId"] = "request", ["llmSegment"] = new JsonObject { ["complete"] = false, ["outputEndExclusive"] = 1 },
        } });
        var updates = Updates(events);
        Assert.Equal("{", updates[^2]["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        Assert.Equal(1, updates[^1]["trimBeforeOutputIndex"]!.GetValue<int>());
        Assert.Equal("", owner.DraftSnapshot()["reasoning"]!.GetValue<string>());
        Assert.Equal(1, owner.DraftSnapshot()["committedThrough"]!.GetValue<int>());
        owner.PublishDraftProgress(Progress("{}", "visible-next"));
        clock.Advance(80);
        Assert.DoesNotContain(Updates(events).Last()["partDeltas"]!.AsArray(), part => part?["outputIndex"]!.GetValue<int>() == 0);
        Assert.Null(Updates(events).Last()["reasoningDelta"]);
        owner.FlushDraft();
        Assert.Equal(1, Updates(events).Last()["toolCallDeltas"]![0]!["argumentsDelta"]!["offset"]!.GetValue<int>());
        Assert.Equal("}", Updates(events).Last()["toolCallDeltas"]![0]!["argumentsDelta"]!["text"]!.GetValue<string>());
        owner.ClearDraft();
    }

    internal static Task Append(SessionOwner owner, JsonObject message) => owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
    {
        var row = (JsonObject)message.DeepClone();
        var meta = row["__meta"] as JsonObject ?? new JsonObject();
        row["__meta"] = meta;
        meta["seq"] = state.NextMessageSeq;
        meta["timestamp"] = 1000;
        var snapshot = state.Snapshot();
        return new CanonicalAppendPreparation(snapshot with { History = snapshot.History.AppendJson([row]), NextMessageSeq = state.NextMessageSeq + 1 }, [row], live =>
        {
            live.History.Add(row);
            live.NextMessageSeq++;
        });
    });
}
