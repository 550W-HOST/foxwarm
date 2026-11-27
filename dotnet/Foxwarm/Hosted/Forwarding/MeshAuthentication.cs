using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Hosted.Forwarding;

internal sealed record MeshAttempt(string Purpose, string Sender, string Receiver, string Tenant, long? Epoch, string Nonce);

/// <summary>Hop authentication shared by one boot's mesh client and listener.</summary>
internal sealed class MeshAuthentication(byte[] key, string boot, TimeProvider? clock = null)
{
    internal const string Header = "Foxwarm-Mesh";
    internal const string Refusal = "Foxwarm-Mesh-Refusal";
    private const int SkewSeconds = 30;
    private readonly TimeProvider clock = clock ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private readonly PriorityQueue<string, long> expiry = new();

    internal (MeshAttempt Attempt, string Header) Sign(string purpose, string receiver, string tenant, long? epoch,
        string method, string authority, string target)
    {
        var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        var attempt = new MeshAttempt(purpose, boot, receiver, tenant, epoch, nonce);
        var fields = new[] { "v1", purpose, boot, receiver, tenant, epoch?.ToString(CultureInfo.InvariantCulture) ?? "",
            clock.GetUtcNow().ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture), nonce };
        var mac = Mac([.. fields, method, authority, target]);
        return (attempt, string.Join(';', fields) + ";" + Convert.ToHexStringLower(mac));
    }

    internal MeshAttempt? Accept(HttpRequest request)
    {
        if (!request.Headers.TryGetValue(Header, out var values) || values.Count != 1 || values[0] is not { Length: <= 2048 } header)
            return null;
        var f = header.Split(';');
        if (f.Length != 9 || f[0] != "v1" || f[1] is not ("activate" or "dispatch") || f[2].Length == 0 || f[3] != boot
            || f[4].Length == 0 || f[7].Length != 32 || !f[7].All(char.IsAsciiHexDigitLower)
            || !long.TryParse(f[6], NumberStyles.None, CultureInfo.InvariantCulture, out var ts))
            return null;
        long? epoch = null;
        if (f[1] == "dispatch")
        {
            if (!long.TryParse(f[5], NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < 1)
                return null;
            epoch = value;
        }
        else if (f[5].Length != 0)
            return null;
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (ts < now - SkewSeconds || ts > now + SkewSeconds || !Matches(f[8],
                Mac([.. f.AsSpan(0, 8), request.Method, request.Host.Value, RawTarget(request)])))
            return null;
        lock (gate)
        {
            while (expiry.TryPeek(out var old, out var until) && until < now)
            {
                expiry.Dequeue();
                seen.Remove(old);
            }
            if (!seen.Add(f[7]))
                return null;
            expiry.Enqueue(f[7], now + 2 * SkewSeconds);
        }
        return new(f[1], f[2], f[3], f[4], epoch, f[7]);
    }

    internal string Refuse(MeshAttempt attempt) => Convert.ToHexStringLower(RefusalMac(attempt));
    internal bool IsRefusal(MeshAttempt attempt, string value) => Matches(value, RefusalMac(attempt));

    private byte[] RefusalMac(MeshAttempt a) => Mac(["refused-v1", a.Purpose, a.Sender, a.Receiver, a.Tenant,
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
