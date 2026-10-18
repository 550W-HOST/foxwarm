using System.Text.RegularExpressions;

namespace Foxwarm.Channels;

internal sealed record ChannelProgressTarget(string Id, TimeSpan Interval, Func<string, Task> Send);

// Bounded, target-local, transient presentation. Never a history row or delivery ledger.
internal sealed class ChannelProgress(TimeProvider? clock = null)
{
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly Dictionary<(string Turn, string Target), State> states = new();
    private long generation;

    private sealed class State(
        string turn,
        ChannelProgressTarget target,
        long generation,
        DateTimeOffset now
    )
    {
        internal readonly string Turn = turn;
        internal ChannelProgressTarget Target = target;
        internal readonly long Generation = generation;
        internal DateTimeOffset Touched = now;
        internal DateTimeOffset Due;
        internal readonly Dictionary<string, int> Started = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, int> Reported = new(StringComparer.Ordinal);
        internal readonly Dictionary<string, string> Running = new(StringComparer.Ordinal);
        internal ITimer? Timer;
        internal bool InFlight;
        internal bool Closed;
    }

    internal void Report(
        string turn,
        IEnumerable<ChannelProgressTarget> targets,
        string callId,
        string tool,
        bool start
    )
    {
        if (tool == "wait")
            return;
        lock (gate)
        {
            var now = time.GetUtcNow();
            foreach (
                var old in states
                    .Where(pair => now - pair.Value.Touched > TimeSpan.FromHours(1))
                    .Select(pair => pair.Key)
                    .ToArray()
            )
                Remove(old);
            foreach (var target in targets.Take(64))
            {
                var key = (turn, target.Id);
                if (!states.TryGetValue(key, out var state))
                {
                    if (!start)
                        continue;
                    if (states.Count >= 4096)
                        Remove(states.MinBy(pair => pair.Value.Touched).Key);
                    states[key] = state = new(turn, target, generation, now);
                }
                state.Target = target;
                state.Touched = now;
                callId = callId[..Math.Min(256, callId.Length)];
                if (start)
                {
                    var name = Regex.Replace(tool, "[\\x00-\\x1F\\x7F-\\x9F`*~|<>]", "").Trim();
                    name = name.Length == 0 ? "tool" : name[..Math.Min(32, name.Length)];
                    if (!state.Started.ContainsKey(name) && state.Started.Count >= 5)
                        name = "other";
                    state.Started[name] = Math.Min(999, state.Started.GetValueOrDefault(name) + 1);
                    if (
                        callId.Length > 0
                        && (state.Running.ContainsKey(callId) || state.Running.Count < 256)
                    )
                        state.Running[callId] = name;
                    if (state.Timer is null && !state.InFlight)
                    {
                        state.Due = now + target.Interval;
                        Arm(state);
                    }
                }
                else
                    state.Running.Remove(callId);
            }
        }
    }

    private void Arm(State state)
    {
        var due = state.Due - time.GetUtcNow();
        state.Timer = time.CreateTimer(
            _ =>
            {
                _ = TickAsync(state);
            },
            null,
            due > TimeSpan.Zero ? due : TimeSpan.Zero,
            Timeout.InfiniteTimeSpan
        );
    }

    private string? Summary(State state, bool standalone, bool heartbeat = false)
    {
        var counts = state.Started.ToDictionary(
            pair => pair.Key,
            pair => Math.Max(0, pair.Value - state.Reported.GetValueOrDefault(pair.Key)),
            StringComparer.Ordinal
        );
        var prefix = standalone ? "⏳ Tools: " : "Tools: ";
        if (!counts.Any(pair => pair.Value > 0) && heartbeat && state.Running.Count > 0)
        {
            counts = state
                .Running.Values.GroupBy(value => value)
                .ToDictionary(group => group.Key, group => group.Count());
            prefix = "⏳ Tools running: ";
        }
        var entries = counts
            .Where(pair => pair.Value > 0)
            .Take(6)
            .Select(pair => pair.Key + " ×" + Math.Min(999, pair.Value));
        var body = string.Join(" · ", entries);
        if (body.Length == 0)
            return null;
        var text = prefix + body;
        return text[..Math.Min(240, text.Length)];
    }

    private async Task TickAsync(State state)
    {
        Task send;
        Dictionary<string, int> baseline;
        lock (gate)
        {
            state.Timer?.Dispose();
            state.Timer = null;
            if (state.Closed || state.Generation != generation)
                return;
            if (time.GetUtcNow() - state.Touched > TimeSpan.FromHours(1))
            {
                Remove((state.Turn, state.Target.Id));
                return;
            }
            var summary = Summary(state, true, heartbeat: true);
            baseline = new(state.Started, StringComparer.Ordinal);
            state.InFlight = true;
            send = summary is null
                ? Task.CompletedTask
                : BestEffortAsync(state.Target.Send, summary);
        }
        await send;
        lock (gate)
        {
            state.InFlight = false;
            if (state.Closed || state.Generation != generation)
                return;
            foreach (var (name, total) in baseline)
                state.Reported[name] = Math.Max(state.Reported.GetValueOrDefault(name), total);
            do
            {
                state.Due += state.Target.Interval;
            } while (state.Due <= time.GetUtcNow());
            if (state.Running.Count > 0 || Summary(state, true) is not null)
                Arm(state);
        }
    }

    internal string Decorate(string turn, string target, string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return text;
        lock (gate)
        {
            if (!states.TryGetValue((turn, target), out var state))
                return text;
            state.Touched = time.GetUtcNow();
            var summary = Summary(state, false);
            if (summary is null)
                return text;
            foreach (var (name, count) in state.Started)
                state.Reported[name] = count;
            return summary + "\n\n" + text;
        }
    }

    internal void Finish(string turn)
    {
        lock (gate)
            foreach (var key in states.Keys.Where(key => key.Turn == turn).ToArray())
            {
                var state = states[key];
                var summary = Summary(state, true);
                Remove(key);
                if (state.InFlight || summary is null)
                    continue;
                _ = Task.Run(async () =>
                {
                    Task send;
                    lock (gate)
                    {
                        if (state.Generation != generation)
                            return;
                        send = BestEffortAsync(state.Target.Send, summary);
                    }
                    await send;
                });
            }
    }

    internal void Reset()
    {
        lock (gate)
        {
            generation++;
            foreach (var key in states.Keys.ToArray())
                Remove(key);
        }
    }

    private void Remove((string Turn, string Target) key)
    {
        if (!states.Remove(key, out var state))
            return;
        state.Closed = true;
        state.Timer?.Dispose();
        state.Timer = null;
    }

    internal static async Task BestEffortAsync(Func<string, Task> send, string text)
    {
        try
        {
            await send(text);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Channel delivery failed: " + error.Message);
        }
    }
}
