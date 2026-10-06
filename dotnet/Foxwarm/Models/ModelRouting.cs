using System.Security.Cryptography;
using System.Text;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class ModelRouting(Func<long>? clock = null)
{
    internal sealed record Selection(string TargetKey, int Index, bool IsLast);

    internal sealed record Failure(bool Terminal, bool EnteredCooldown, int ConsecutiveFailures);

    internal sealed record Health(int ConsecutiveFailures, long CooldownUntil);

    internal sealed record Request(
        string VirtualKey,
        string Strategy,
        string Fingerprint,
        string[] Targets,
        int FailureThreshold,
        int CooldownMs,
        long Generation,
        Dictionary<string, Health> Health
    );

    private sealed record Active(
        string Fingerprint,
        long Generation,
        Dictionary<string, Health> Health
    );

    private readonly object gate = new();
    private readonly Dictionary<string, Active> active = new(StringComparer.Ordinal);
    private long nextGeneration = 1;
    private long Now => clock?.Invoke() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    internal Request Begin(string virtualKey, ConcreteHostModel model)
    {
        if (!model.IsVirtual)
            throw new InvalidOperationException("Selected model is not virtual.");
        var fingerprint = SessionWait.Text(model.Configuration["fingerprint"])!;
        lock (gate)
        {
            Active route;
            if (model.ProviderType == "session-hash")
            {
                active.Remove(virtualKey);
                route = new Active(fingerprint, 0, new(StringComparer.Ordinal));
            }
            else if (
                !active.TryGetValue(virtualKey, out route!)
                || route.Fingerprint != fingerprint
            )
            {
                route = new Active(fingerprint, nextGeneration++, new(StringComparer.Ordinal));
                active[virtualKey] = route;
            }
            return new Request(
                virtualKey,
                model.ProviderType,
                fingerprint,
                [.. model.Targets],
                HostModels.Positive(model.Configuration["failureThreshold"], 5, "failureThreshold"),
                HostModels.Positive(model.Configuration["cooldownMs"], 600000, "cooldownMs"),
                route.Generation,
                route.Health
            );
        }
    }

    internal void Clear(string key)
    {
        lock (gate)
            active.Remove(key);
    }

    internal static Selection Hash(
        string virtualKey,
        string routingKey,
        IReadOnlyList<string> targets
    )
    {
        if (targets.Count == 0)
            throw new InvalidOperationException("Virtual model has no targets.");
        byte[]? greatest = null;
        var selected = 0;
        for (var index = 0; index < targets.Count; index++)
        {
            var digest = SHA256.HashData(
                Encoding.UTF8.GetBytes(virtualKey + "\0" + routingKey + "\0" + targets[index])
            );
            var comparison = greatest is null ? 1 : digest.AsSpan().SequenceCompareTo(greatest);
            if (
                comparison > 0
                || comparison == 0
                    && StringComparer.Ordinal.Compare(targets[index], targets[selected]) < 0
            )
            {
                selected = index;
                greatest = digest;
            }
        }
        return new Selection(targets[selected], selected, selected == targets.Count - 1);
    }

    internal Selection Select(Request request, string routingKey)
    {
        if (request.Strategy == "session-hash")
            return Hash(request.VirtualKey, routingKey, request.Targets);
        var now = Now;
        lock (gate)
        {
            for (var index = 0; index < request.Targets.Length; index++)
            {
                var target = request.Targets[index];
                if (request.Health.TryGetValue(target, out var health) && health.CooldownUntil > 0)
                {
                    if (health.CooldownUntil > now)
                        continue;
                    request.Health.Remove(target);
                }
                return new Selection(target, index, index == request.Targets.Length - 1);
            }
            return new Selection(request.Targets[^1], request.Targets.Length - 1, true);
        }
    }

    internal void Success(Request request, string target)
    {
        if (request.Strategy != "failover")
            return;
        lock (gate)
            request.Health.Remove(target);
    }

    internal Failure Failed(Request request, Selection selection)
    {
        if (request.Strategy != "failover")
            return new(false, false, 0);
        var now = Now;
        lock (gate)
        {
            if (selection.IsLast)
            {
                var current =
                    active.TryGetValue(request.VirtualKey, out var value)
                    && value.Fingerprint == request.Fingerprint
                    && value.Generation == request.Generation
                    && ReferenceEquals(value.Health, request.Health);
                request.Health.Clear();
                if (current)
                    active[request.VirtualKey] = new Active(
                        request.Fingerprint,
                        nextGeneration++,
                        new(StringComparer.Ordinal)
                    );
                return new(true, false, 1);
            }
            request.Health.TryGetValue(selection.TargetKey, out var previous);
            var streak = (previous?.ConsecutiveFailures ?? 0) + 1;
            var cooled = streak >= request.FailureThreshold;
            request.Health[selection.TargetKey] = new Health(
                streak,
                cooled ? now + request.CooldownMs : 0
            );
            return new(false, cooled, streak);
        }
    }
}
