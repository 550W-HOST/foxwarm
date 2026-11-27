namespace Foxwarm;

/// <summary>
/// A hosted tenant's capability profile, the operator-owned <c>tenants.profile</c> column. It
/// selects the runtime's <see cref="RuntimeCapabilities"/>, the tenant configuration paths and
/// the operator ceiling document. It is read when a runtime is built and fixed for that runtime:
/// a profile change takes effect only through a new runtime (a move), never live. Plain data,
/// outside <c>Hosted/</c>, so builds without hosted mode compile the code that names it.
/// </summary>
internal enum TenantProfile
{
    /// <summary>P1's profile: no master Node, no Main-local execution, the deployment's Providers.</summary>
    Hosted,

    /// <summary>File mode's full set over hosted stores, for the operator's own tenant.</summary>
    Operator,
}

internal static class TenantProfiles
{
    /// <summary>The stored name of <paramref name="profile"/>.</summary>
    internal static string Name(TenantProfile profile) =>
        profile switch
        {
            TenantProfile.Hosted => "hosted",
            TenantProfile.Operator => "operator",
            _ => throw new ArgumentOutOfRangeException(nameof(profile)),
        };

    /// <summary>The profile a stored name denotes; the schema admits no other value.</summary>
    internal static TenantProfile Parse(string? value) =>
        value switch
        {
            "hosted" => TenantProfile.Hosted,
            "operator" => TenantProfile.Operator,
            _ => throw new InvalidDataException($"Unknown tenant profile `{value}`."),
        };
}
