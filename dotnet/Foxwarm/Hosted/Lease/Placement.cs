using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Hosted.Lease;

/// <summary>One replica boot as placement sees it.</summary>
/// <param name="Replica">The per-boot ID: the lease owner.</param>
/// <param name="Name">The stable logical name placement ranks by.</param>
/// <param name="Capacity">The replica's advertised capacity, consulted only for new placement.</param>
internal sealed record ReplicaRow(
    string Replica,
    string Name,
    string Role,
    bool Draining,
    JsonObject Capacity,
    DateTimeOffset StartedAt
);

/// <summary>
/// Rendezvous placement (plan §3.3). The rank is a preference that orders activation attempts;
/// the lease decides the owner, and the hard constraints are checked at acquisition itself
/// (<see cref="ReplicaRoles.MayServe"/>, tenant state, reader version), never here alone.
/// </summary>
internal static class Placement
{
    /// <summary>
    /// <c>score(t, r) = hash64(slug ‖ name)</c>: the first 8 bytes of SHA-256 over the slug, a
    /// zero byte and the logical name, as an unsigned big-endian integer. Stable across
    /// processes, platforms and versions.
    /// </summary>
    internal static ulong Score(string slug, string name)
    {
        var input = Encoding.UTF8.GetBytes(slug + "\0" + name);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(input, hash);
        return BinaryPrimitives.ReadUInt64BigEndian(hash);
    }

    /// <summary>Logical names in descending score for <paramref name="slug"/>; ties break by name.</summary>
    internal static IReadOnlyList<string> Rank(string slug, IEnumerable<string> names) =>
        [
            .. names
                .Distinct(StringComparer.Ordinal)
                .OrderByDescending(name => Score(slug, name))
                .ThenBy(name => name, StringComparer.Ordinal),
        ];

    /// <summary>
    /// The candidates for a new placement of a tenant with this profile and pin, in rank order:
    /// live boots whose role may serve it and that aren't draining. Two live boots with one
    /// logical name count as one: the older boot, so a restarted replica is ineligible until
    /// its predecessor's heartbeat expires. <paramref name="accepts"/> is the capacity filter;
    /// it applies to new placement only, never to an owner with a valid grant.
    /// </summary>
    internal static IReadOnlyList<ReplicaRow> Candidates(
        string slug,
        TenantProfile profile,
        string? pinnedRole,
        IEnumerable<ReplicaRow> live,
        Func<ReplicaRow, bool>? accepts = null
    )
    {
        var byName = live
            .GroupBy(row => row.Name, StringComparer.Ordinal)
            .Select(boots => boots.OrderBy(row => row.StartedAt).ThenBy(row => row.Replica, StringComparer.Ordinal).First())
            .Where(row => !row.Draining && ReplicaRoles.MayServe(row.Role, profile, pinnedRole))
            .Where(row => accepts?.Invoke(row) ?? true)
            .ToDictionary(row => row.Name, StringComparer.Ordinal);
        return [.. Rank(slug, byName.Keys).Select(name => byName[name])];
    }
}
