using System.Net;
using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace Foxwarm.Net;

/// <summary>What an outbound connection is for. It selects the rules a connection is checked by.</summary>
internal enum EgressPurpose
{
    /// <summary>Model providers, Setup probes, Responses WebSockets and text-redaction detection.</summary>
    Model,

    /// <summary>Outbound MCP servers over HTTP or SSE, and their OAuth discovery and tokens.</summary>
    Mcp,

    /// <summary>Managed channels (Telegram, Matrix, QQ Bot, WeWork, Weixin).</summary>
    Channel,

    /// <summary>
    /// A destination the deployment configuration names, not the tenant (the ASR service). It is
    /// checked with the operator profile's rules.
    /// </summary>
    Deployment,
}

/// <summary>The capability profile an egress policy enforces.</summary>
internal enum EgressProfile
{
    /// <summary>File mode: today's handlers, no checks.</summary>
    Unguarded,

    /// <summary>Hosted tenants: internal destinations are denied.</summary>
    Hosted,

    /// <summary>The operator tenant: internal destinations are allowed.</summary>
    Operator,
}

/// <summary>A connection the egress policy refused before any byte was sent.</summary>
internal sealed class EgressDeniedException(string host, IPAddress? address)
    : IOException(Copy(host))
{
    internal string Host => host;
    internal IPAddress? Address => address;

    // Draft copy; the coordinator owns the final text.
    private static string Copy(string host) =>
        $"Connections to {host} are not allowed: it is an internal network address.";
}

/// <summary>
/// The deployment's egress settings (<c>egress</c> in the deployment configuration):
/// <c>deny</c> adds CIDRs to the denied set of every guarded profile (cluster pods and
/// services, the database, object storage, the mesh); <c>allow.hosted</c> and
/// <c>allow.operator</c> list CIDRs or host names that a profile may reach even though they are
/// denied.
/// </summary>
internal sealed record EgressRules(
    IReadOnlyList<IPNetwork> Deny,
    EgressAllowList HostedAllow,
    EgressAllowList OperatorAllow
)
{
    internal static EgressRules None { get; } = new([], EgressAllowList.Empty, EgressAllowList.Empty);

    /// <summary>Parses the <c>egress</c> block; null is <see cref="None"/>.</summary>
    internal static EgressRules Parse(JsonNode? node)
    {
        if (node is null)
            return None;
        if (node is not JsonObject block)
            throw new InvalidDataException("`egress` must be a mapping.");
        IReadOnlyList<IPNetwork> deny = [];
        var hosted = EgressAllowList.Empty;
        var @operator = EgressAllowList.Empty;
        foreach (var (key, value) in block)
            switch (key)
            {
                case "deny":
                    deny = Entries(value, "egress.deny")
                        .Select(entry =>
                            Network(entry.Text)
                            ?? throw new InvalidDataException(
                                $"`{entry.Path}` must be an IP address or CIDR."
                            )
                        )
                        .ToArray();
                    break;
                case "allow":
                    if (value is not JsonObject allow)
                        throw new InvalidDataException("`egress.allow` must be a mapping.");
                    foreach (var (profile, list) in allow)
                        switch (profile)
                        {
                            case "hosted":
                                hosted = EgressAllowList.Parse(Entries(list, "egress.allow.hosted"));
                                break;
                            case "operator":
                                @operator = EgressAllowList.Parse(
                                    Entries(list, "egress.allow.operator")
                                );
                                break;
                            default:
                                throw new InvalidDataException(
                                    $"`egress.allow.{profile}` isn't a setting."
                                );
                        }
                    break;
                default:
                    throw new InvalidDataException($"`egress.{key}` isn't a setting.");
            }
        return new(deny, hosted, @operator);
    }

    private static IEnumerable<(string Path, string Text)> Entries(JsonNode? node, string path)
    {
        if (node is null)
            return [];
        if (node is not JsonArray array)
            throw new InvalidDataException($"`{path}` must be a list.");
        return array
            .Select(
                (item, index) =>
                    (
                        $"{path}[{index}]",
                        item is JsonValue value && value.TryGetValue<string>(out var text)
                            ? text.Trim()
                            : throw new InvalidDataException($"`{path}[{index}]` must be text.")
                    )
            )
            .ToArray();
    }

    /// <summary>A CIDR, or a single address as a full-length prefix; null for anything else.</summary>
    internal static IPNetwork? Network(string text)
    {
        if (text.Contains('/'))
            return IPNetwork.TryParse(text, out var network) ? network : null;
        return IPAddress.TryParse(text.Trim('[', ']'), out var address)
            ? new IPNetwork(address, address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128)
            : null;
    }
}

/// <summary>Allow exceptions of one profile: networks and exact host names.</summary>
internal sealed record EgressAllowList(
    IReadOnlyList<IPNetwork> Networks,
    IReadOnlySet<string> Hosts
)
{
    internal static EgressAllowList Empty { get; } =
        new([], new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    internal static EgressAllowList Parse(IEnumerable<(string Path, string Text)> entries)
    {
        var networks = new List<IPNetwork>();
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (path, text) in entries)
            if (EgressRules.Network(text) is { } network)
                networks.Add(network);
            else if (Uri.CheckHostName(text.TrimEnd('.')) == UriHostNameType.Dns)
                hosts.Add(text.TrimEnd('.'));
            else
                throw new InvalidDataException(
                    $"`{path}` must be an IP address, a CIDR or a host name."
                );
        return new(networks, hosts);
    }

    internal bool Contains(IPAddress address) =>
        Networks.Any(network => network.Contains(address));
}

/// <summary>
/// The addresses a hosted tenant may not reach by default (plan §7.1): loopback,
/// <c>0.0.0.0/8</c>, RFC 1918, CGNAT, link-local (with the metadata address
/// <c>169.254.169.254</c>), the IANA special-purpose and documentation ranges, multicast,
/// reserved and broadcast, <c>fc00::/7</c>, <c>fe80::/10</c>, <c>ff00::/8</c>, and all of
/// <c>::/16</c>: the unspecified and loopback addresses and every IPv4-compatible form. An
/// IPv4-mapped address is checked as the IPv4 address it maps.
/// </summary>
internal static class EgressAddresses
{
    private static readonly IPNetwork[] InternalV4 =
    [
        IPNetwork.Parse("0.0.0.0/8"),
        IPNetwork.Parse("10.0.0.0/8"),
        IPNetwork.Parse("100.64.0.0/10"),
        IPNetwork.Parse("127.0.0.0/8"),
        IPNetwork.Parse("169.254.0.0/16"),
        IPNetwork.Parse("172.16.0.0/12"),
        IPNetwork.Parse("192.0.0.0/24"),
        IPNetwork.Parse("192.0.2.0/24"),
        IPNetwork.Parse("192.168.0.0/16"),
        IPNetwork.Parse("198.18.0.0/15"),
        IPNetwork.Parse("198.51.100.0/24"),
        IPNetwork.Parse("203.0.113.0/24"),
        // Multicast 224/4, reserved 240/4 and the limited broadcast address.
        IPNetwork.Parse("224.0.0.0/3"),
    ];

    private static readonly IPNetwork[] InternalV6 =
    [
        IPNetwork.Parse("::/16"),
        IPNetwork.Parse("fc00::/7"),
        IPNetwork.Parse("fe80::/10"),
        IPNetwork.Parse("ff00::/8"),
    ];

    /// <summary>An IPv4-mapped IPv6 address as its IPv4 address; anything else unchanged.</summary>
    internal static IPAddress Normalize(IPAddress address) =>
        address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;

    internal static bool IsInternal(IPAddress address)
    {
        address = Normalize(address);
        if (address.AddressFamily == AddressFamily.InterNetwork)
            return InternalV4.Any(network => network.Contains(address));
        // A scoped address (fe80::1%2) compares by its bytes.
        if (address.ScopeId != 0)
            address = new IPAddress(address.GetAddressBytes());
        return InternalV6.Any(network => network.Contains(address));
    }
}

/// <summary>
/// The egress policy of one runtime, fixed when it is built. File mode is
/// <see cref="Unguarded"/>: every client is built exactly as before the guard existed. A guarded
/// policy resolves each new connection's host once, checks every address, and connects to a
/// checked address without resolving again (see <see cref="EgressHttp"/>).
/// </summary>
internal sealed class EgressPolicy
{
    private readonly EgressRules rules;
    private EgressPolicy? deployment;

    private EgressPolicy(
        EgressProfile profile,
        EgressRules rules,
        Func<string, CancellationToken, Task<IPAddress[]>>? resolver = null,
        Func<IPEndPoint, CancellationToken, ValueTask<Stream>>? connector = null
    )
    {
        Profile = profile;
        this.rules = rules;
        Resolver = resolver ?? Dns.GetHostAddressesAsync;
        Connector = connector ?? ConnectSocketAsync;
    }

    /// <summary>The same policy over another resolver and connector (the test fixture).</summary>
    internal EgressPolicy WithTransport(
        Func<string, CancellationToken, Task<IPAddress[]>> resolver,
        Func<IPEndPoint, CancellationToken, ValueTask<Stream>> connector
    ) => new(Profile, rules, resolver, connector);

    /// <summary>File mode.</summary>
    internal static EgressPolicy Unguarded { get; } = new(EgressProfile.Unguarded, EgressRules.None);

    internal static EgressPolicy Hosted(EgressRules? rules = null) =>
        new(EgressProfile.Hosted, rules ?? EgressRules.None);

    internal static EgressPolicy Operator(EgressRules? rules = null) =>
        new(EgressProfile.Operator, rules ?? EgressRules.None);

    internal EgressProfile Profile { get; }

    internal bool Guarded => Profile != EgressProfile.Unguarded;

    /// <summary>Host name resolution; a test resolver replaces it.</summary>
    internal Func<string, CancellationToken, Task<IPAddress[]>> Resolver { get; }

    /// <summary>The TCP connect to one checked address; a test fixture replaces it.</summary>
    internal Func<IPEndPoint, CancellationToken, ValueTask<Stream>> Connector { get; }

    /// <summary>The policy a purpose's connections are checked by.</summary>
    internal EgressPolicy For(EgressPurpose purpose)
    {
        if (purpose != EgressPurpose.Deployment || Profile != EgressProfile.Hosted)
            return this;
        return deployment ??= new(EgressProfile.Operator, rules, Resolver, Connector);
    }

    private EgressAllowList Allow =>
        Profile == EgressProfile.Operator ? rules.OperatorAllow : rules.HostedAllow;

    /// <summary>Whether a host name is an allow exception, so its addresses aren't checked.</summary>
    internal bool AllowsHost(string host) => Guarded && Allow.Hosts.Contains(host.TrimEnd('.'));

    /// <summary>Whether this policy refuses a connection to the address.</summary>
    internal bool Denies(IPAddress address)
    {
        if (!Guarded)
            return false;
        var normalized = EgressAddresses.Normalize(address);
        if (Allow.Contains(normalized) || Allow.Contains(address))
            return false;
        if (rules.Deny.Any(network => network.Contains(normalized) || network.Contains(address)))
            return true;
        return Profile == EgressProfile.Hosted && EgressAddresses.IsInternal(address);
    }

    /// <summary>
    /// The host's addresses, every one of them checked: a literal is itself, a name is resolved
    /// once. One denied address refuses the connection, so a name can't mix a public address
    /// with an internal one.
    /// </summary>
    internal async Task<IPAddress[]> ResolveCheckedAsync(string host, CancellationToken token)
    {
        host = host.Trim('[', ']');
        var addresses = IPAddress.TryParse(host, out var literal)
            ? [literal]
            : await Resolver(host, token).ConfigureAwait(false);
        if (addresses.Length == 0)
            throw new SocketException((int)SocketError.HostNotFound);
        if (AllowsHost(host))
            return addresses;
        foreach (var address in addresses)
            if (Denies(address))
                throw new EgressDeniedException(host, address);
        return addresses;
    }

    /// <summary>Connects to the first reachable address of an already checked set.</summary>
    internal async ValueTask<Stream> ConnectAsync(
        IReadOnlyList<IPAddress> addresses,
        int port,
        CancellationToken token
    )
    {
        Exception? last = null;
        foreach (var address in addresses)
            try
            {
                // An IPv4-mapped address is connected as IPv4: the socket isn't dual-mode.
                var endpoint = new IPEndPoint(EgressAddresses.Normalize(address), port);
                return await Connector(endpoint, token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                last = error;
                token.ThrowIfCancellationRequested();
            }
        throw last ?? new SocketException((int)SocketError.HostNotFound);
    }

    private static async ValueTask<Stream> ConnectSocketAsync(
        IPEndPoint endpoint,
        CancellationToken token
    )
    {
        // As SocketsHttpHandler's own connect does.
        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true,
        };
        try
        {
            await socket.ConnectAsync(endpoint, token).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}
