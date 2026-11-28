using System.Text.Json.Nodes;

namespace Foxwarm.Nodes;

/// <summary>Limits on one deployment Provider granted to one installation.</summary>
internal sealed record ProviderQuotas(int Nodes = 10, int Execs = 8, int LifecycleActionsPerHour = 60);

/// <summary>Only contains drivers whose actual description matched the deployment declaration.</summary>
internal sealed class TenantProviders
{
    internal Dictionary<string, ExecutableNodeProvider> Drivers { get; } = new(StringComparer.Ordinal);
    internal JsonObject Problems { get; } = new();
}
