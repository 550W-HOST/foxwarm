using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm;

// Issued only by the Main access owner. Wire arguments and ClientInfo never create authority.
internal sealed class McpExternalPrincipal
{
    internal string Id { get; }
    private readonly AccessConfiguration access;
    private readonly AccessIdentity captured;

    private McpExternalPrincipal(AccessConfiguration access, string id, AccessIdentity captured)
    {
        this.access = access;
        Id = id;
        this.captured = captured;
    }

    internal static McpExternalPrincipal? Authenticate(AccessConfiguration access, string token)
    {
        McpExternalPrincipal? result = null;
        foreach (var (id, identity) in access.Snapshot)
            if (identity.Mcp && AccessConfiguration.Equal(token, identity.Token))
                result = new(access, id, identity);
        return result;
    }

    internal bool Current =>
        access.Snapshot.TryGetValue(Id, out var next) && next.Mcp && next.Token == captured.Token;
}

internal sealed class McpExternalContext(McpExternalPrincipal principal)
{
    private readonly object gate = new();
    internal string Id { get; } = Guid.NewGuid().ToString();
    internal string ExternalId => principal.Id;
    private bool disposed;
    internal McpReplyChannel? ReplyChannel { get; set; }
    private string node = "master";
    private string? cwd;
    private long generation;
    private readonly HashSet<string> usedNodes = new(StringComparer.Ordinal);
    internal CancellationTokenSource Lifetime { get; } = new();
    internal bool Available
    {
        get
        {
            lock (gate)
                return !disposed && principal.Current;
        }
    }

    internal void Require()
    {
        if (!Available)
            throw new McpInboundSafeException("External context is unavailable.");
    }

    internal (string Node, string? Cwd, long Generation) Selection
    {
        get
        {
            lock (gate)
                return (node, cwd, generation);
        }
    }

    internal void Select(string id, string? defaultCwd)
    {
        lock (gate)
        {
            Require();
            node = id;
            cwd = defaultCwd;
            generation++;
        }
    }

    internal void UpdateCwd(string id, long selectedGeneration, string value)
    {
        lock (gate)
            if (!disposed && node == id && generation == selectedGeneration)
                cwd = value;
    }

    internal void UsedNode(string id)
    {
        lock (gate)
        {
            Require();
            usedNodes.Add(id);
        }
    }

    internal string[] Fence()
    {
        string[] nodes;
        lock (gate)
        {
            disposed = true;
            nodes = usedNodes.ToArray();
            usedNodes.Clear();
        }
        ReplyChannel?.Stop();
        Lifetime.Cancel();
        return nodes;
    }

    internal JsonObject WireOwner() =>
        new()
        {
            ["kind"] = "external",
            ["externalId"] = ExternalId,
            ["contextId"] = Id,
        };
}

internal sealed class McpInboundSafeException(string message) : InvalidOperationException(message);

internal sealed class McpExternalAuthorization(
    ToolAuthorizationAuthority authority,
    string workspace,
    Foxwarm.Nodes.ApprovedNodeRegistry? nodes = null
)
{
    internal ToolAuthorizationRequest Request(
        McpExternalContext context,
        string source,
        string name,
        JsonObject args,
        string? server = null,
        string? node = null,
        IReadOnlyList<AuthorizationPath>? paths = null
    )
    {
        var targets = ToolAuthorizationNodeEffects.Resolve(source, name, node, args);
        return new(
            source,
            name,
            server,
            args,
            paths ?? [],
            null,
            context.Id,
            node,
            workspace,
            null,
            null,
            Principal: "external",
            ExternalId: context.ExternalId,
            NodeTargets: targets,
            NodeForest: targets is { Count: > 0 } ? nodes?.Forest() : null
        );
    }

    internal async Task RequireAsync(
        McpExternalContext context,
        ToolAuthorizationRequest request,
        CancellationToken token
    )
    {
        context.Require();
        var policy = await authority.LoadAsync(token);
        Require(context, request, policy);
    }

    internal void Require(
        McpExternalContext context,
        ToolAuthorizationRequest request,
        ToolAuthorizationPolicy? policy = null
    )
    {
        context.Require();
        if (!ToolAuthorizationEvaluation.Evaluate(policy ?? authority.Load(), request).Allowed)
            throw new McpInboundSafeException("Tool action is not permitted.");
    }

    internal bool Visible(McpExternalContext context, ToolAuthorizationRequest request)
    {
        context.Require();
        return ToolAuthorizationEvaluation.Visible(authority.Load(), request);
    }
}
