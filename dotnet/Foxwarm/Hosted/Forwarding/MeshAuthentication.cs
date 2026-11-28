using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Hosted.Forwarding;

internal sealed record MeshAttempt(string Purpose, string Sender, string Receiver, string Tenant, int TenantId, long? Epoch, string Nonce);

/// <summary>Hop authentication shared by one boot's mesh client and listener.</summary>
internal sealed class MeshAuthentication(byte[] key, string boot, TimeProvider? clock = null, int nonceLimit = MeshAuthentication.MaxNonces)
{
    internal const string Header = "Foxwarm-Mesh";
    internal const string Refusal = "Foxwarm-Mesh-Refusal";
    internal const int MaxNonces = 262_144;
    private const int SkewSeconds = 30;
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly HashSet<UInt128> seen = [];
    private readonly PriorityQueue<(UInt128 Nonce, NonceShare Share), long> expiry = new();
    private readonly NoncePool dispatch = new(nonceLimit - ActivationReserve(nonceLimit), Math.Max(1, nonceLimit / 8));
    private readonly NoncePool activation = new(ActivationReserve(nonceLimit), Math.Max(1, ActivationReserve(nonceLimit) / 8));

    private static int ActivationReserve(int limit) => Math.Max(1, limit / 16);

    // Used under gate. Entries in the expiry queue share the tenant key and counters.
    private sealed class NonceShare(NoncePool pool, int tenant)
    {
        internal readonly NoncePool Pool = pool;
        internal readonly int TenantId = tenant;
        internal int Used;
    }

    private sealed class NoncePool(int capacity, int tenantLimit)
    {
        private readonly Dictionary<int, NonceShare> tenants = [];
        private int used;

        internal NonceShare? TryTake(int tenant)
        {
            if (used >= capacity) return null;
            if (!tenants.TryGetValue(tenant, out var share))
                tenants.Add(tenant, share = new NonceShare(this, tenant));
            if (share.Used >= tenantLimit) return null;
            used++;
            share.Used++;
            return share;
        }

        internal void Expire(NonceShare share)
        {
            used--;
            if (--share.Used == 0) tenants.Remove(share.TenantId);
        }
    }

    internal (MeshAttempt Attempt, string Header) Sign(string purpose, string receiver, string tenant, int tenantId, long? epoch,
        string method, string authority, string target)
    {
        var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        var attempt = new MeshAttempt(purpose, boot, receiver, tenant, tenantId, epoch, nonce);
        var fields = new[] { "v2", purpose, boot, receiver, tenant, tenantId.ToString(CultureInfo.InvariantCulture), epoch?.ToString(CultureInfo.InvariantCulture) ?? "",
            clock.GetUtcNow().ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture), nonce };
        var mac = Mac([.. fields, method, authority, target]);
        return (attempt, string.Join(';', fields) + ";" + Convert.ToHexStringLower(mac));
    }

    internal MeshAttempt? Accept(HttpRequest request) => Accept(request, out _);

    internal MeshAttempt? Accept(HttpRequest request, out bool full)
    {
        full = false;
        if (!request.Headers.TryGetValue(Header, out var values) || values.Count != 1 || values[0] is not { Length: <= 2048 } header)
            return null;
        var f = header.Split(';');
        if (f.Length != 10 || f[0] != "v2" || f[1] is not ("activate" or "dispatch") || f[2].Length == 0 || f[3] != boot
            || !int.TryParse(f[5], NumberStyles.None, CultureInfo.InvariantCulture, out var tenantId) || tenantId <= 0
            || f[4].Length == 0 || f[8].Length != 32 || !f[8].All(char.IsAsciiHexDigitLower)
            || !long.TryParse(f[7], NumberStyles.None, CultureInfo.InvariantCulture, out var ts))
            return null;
        long? epoch = null;
        if (f[1] == "dispatch")
        {
            if (!long.TryParse(f[6], NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < 1)
                return null;
            epoch = value;
        }
        else if (f[6].Length != 0)
            return null;
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (ts < now - SkewSeconds || ts > now + SkewSeconds || !Matches(f[9],
                Mac([.. f.AsSpan(0, 9), request.Method, request.Host.Value, RawTarget(request)])))
            return null;
        lock (gate)
        {
            while (expiry.TryPeek(out var old, out var until) && until < now)
            {
                expiry.Dequeue();
                seen.Remove(old.Nonce);
                old.Share.Pool.Expire(old.Share);
            }
            var nonce = UInt128.Parse(f[8], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            if (seen.Contains(nonce)) return null;
            var share = (f[1] == "activate" ? activation : dispatch).TryTake(tenantId);
            if (share is null)
            {
                full = true;
                return null;
            }
            seen.Add(nonce);
            expiry.Enqueue((nonce, share), now + 2 * SkewSeconds);
        }
        return new(f[1], f[2], f[3], f[4], tenantId, epoch, f[8]);
    }

    internal string Refuse(MeshAttempt attempt) => Convert.ToHexStringLower(RefusalMac(attempt));
    internal bool IsRefusal(MeshAttempt attempt, string value) => Matches(value, RefusalMac(attempt));

    private byte[] RefusalMac(MeshAttempt a) => Mac(["refused-v2", a.Purpose, a.Sender, a.Receiver, a.Tenant, a.TenantId.ToString(CultureInfo.InvariantCulture),
        a.Epoch?.ToString(CultureInfo.InvariantCulture) ?? "", a.Nonce]);

    private byte[] Mac(string[] fields)
    {
        using var mac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, key);
        Span<byte> prefix = stackalloc byte[4];
        foreach (var field in fields)
        {
            var bytes = Encoding.UTF8.GetBytes(field);
            BinaryPrimitives.WriteInt32BigEndian(prefix, bytes.Length);
            mac.AppendData(prefix);
            mac.AppendData(bytes);
        }
        return mac.GetHashAndReset();
    }

    private static bool Matches(string hex, byte[] expected)
    {
        Span<byte> bytes = stackalloc byte[32];
        return hex.Length == 64 && Convert.FromHexString(hex, bytes, out _, out _) == System.Buffers.OperationStatus.Done
            && CryptographicOperations.FixedTimeEquals(bytes, expected);
    }

    internal static string RawTarget(HttpRequest request) => request.HttpContext.Features.Get<IHttpRequestFeature>()?.RawTarget
        ?? (request.PathBase.Add(request.Path).ToUriComponent() + request.QueryString.ToUriComponent());

    internal static void StripControlHeaders(IHeaderDictionary headers)
    {
        foreach (var name in headers.Keys.Where(IsControlHeader).ToArray())
            headers.Remove(name);
    }

    internal static bool IsControlHeader(string name) => name.Equals("Forwarded", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase)
        || name.Equals(Header, StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("Foxwarm-Mesh-", StringComparison.OrdinalIgnoreCase);
}
