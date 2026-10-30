using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Separate from access identities: these records never survive the Main process.
internal sealed class SessionRuntimeCredentialStore
{
    private readonly object gate = new();
    private readonly Dictionary<string, ClaudeRuntimeRun> runs = new(StringComparer.Ordinal);
    private readonly Func<DateTimeOffset> clock;
    private bool closed;

    internal SessionRuntimeCredentialStore(Func<DateTimeOffset>? clock = null) =>
        this.clock = clock ?? (() => DateTimeOffset.UtcNow);

    internal ClaudeRuntimeRun Issue(SessionOwner owner, TimeSpan lifetime, Func<bool> current)
    {
        lock (gate)
        {
            if (closed)
                throw new InvalidOperationException("Runtime admission is closed.");
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var run = new ClaudeRuntimeRun(owner, token, lifetime, current, clock);
            runs.Add(token, run);
            return run;
        }
    }

    internal ClaudeRuntimeRun? Authenticate(string token)
    {
        lock (gate)
            return !closed && runs.TryGetValue(token, out var run) && run.Available ? run : null;
    }

    internal void Retire(ClaudeRuntimeRun run)
    {
        run.Revoke();
        lock (gate)
            runs.Remove(run.Token);
    }

    internal void Revoke(SessionOwner owner)
    {
        lock (gate)
            foreach (var run in runs.Values.Where(r => ReferenceEquals(r.Owner, owner)))
                run.Revoke();
    }

    internal void Close()
    {
        lock (gate)
        {
            closed = true;
            foreach (var run in runs.Values)
                run.Revoke();
            runs.Clear();
        }
    }
}

internal sealed class ClaudeRuntimeRun
{
    private readonly object gate = new();
    private readonly Func<bool> current;
    private readonly Func<DateTimeOffset> clock;
    private readonly TimeSpan lifetime;
    private DateTimeOffset expires;
    private bool revoked;
    internal SessionOwner Owner { get; }
    internal string SessionId { get; }
    internal string Agent { get; }
    internal string Token { get; }
    internal Func<bool>? ChildAlive { get; set; }
    internal string Id { get; } = Guid.NewGuid().ToString("N");
    internal SemaphoreSlim Lane { get; } = new(1, 1);
    internal Func<string, JsonObject, CancellationToken, Task<JsonObject>>? Call { get; set; }
    internal CancellationTokenSource Cancellation { get; } = new();

    internal ClaudeRuntimeRun(
        SessionOwner owner,
        string token,
        TimeSpan lifetime,
        Func<bool> current,
        Func<DateTimeOffset> clock
    )
    {
        Owner = owner;
        SessionId = owner.Id;
        Agent = owner.Agent;
        Token = token;
        this.current = current;
        this.clock = clock;
        this.lifetime = lifetime;
        expires = clock() + lifetime;
    }

    internal bool Available
    {
        get
        {
            lock (gate)
                return !revoked
                    && clock() < expires
                    && Owner.Id == SessionId
                    && Owner.Agent == Agent
                    && current()
                    && (ChildAlive?.Invoke() ?? true);
        }
    }

    internal void RequireObservation()
    {
        lock (gate)
            if (revoked || Owner.Id != SessionId || Owner.Agent != Agent || !current())
                throw new InvalidOperationException(
                    "External runtime no longer owns foreground publication."
                );
    }

    internal void Require()
    {
        if (!Available)
            throw new InvalidOperationException(
                "External runtime run authority has expired or been revoked."
            );
    }

    internal bool Renew()
    {
        lock (gate)
        {
            if (!Available)
                return false;
            expires = clock() + lifetime;
            return true;
        }
    }

    internal void Revoke()
    {
        lock (gate)
        {
            if (revoked)
                return;
            revoked = true;
        }
        Cancellation.Cancel();
    }
}
