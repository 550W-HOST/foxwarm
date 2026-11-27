namespace Foxwarm;

/// <summary>
/// The features a runtime has, fixed when it is built. File mode has all of them. A hosted
/// replica runs in a container with no local execution environment for Agents, so it has no
/// <c>master</c> Node, no Main-local terminals or Code, no stdio MCP servers and no Claude
/// runtime; its executable Providers are the deployment configuration's <c>nodeProviders</c>.
/// A hosted runtime's set comes from its tenant's stored profile (<see cref="For"/>).
/// Model-facing tool declarations never depend on this profile (request-prefix stability).
/// </summary>
/// <param name="MasterNode">
/// The Main server is a Node: <c>master</c> is listed, selectable and the target of Main-local
/// file, exec and browser tools.
/// </param>
/// <param name="MainTerminalsAndCode">Main-local terminals and the Code workbench routes.</param>
/// <param name="StdioMcp">Outbound MCP servers launched as local commands.</param>
/// <param name="ClaudeRuntime">The external Claude Code runtime for Sessions.</param>
/// <param name="ExecutableProviders">Executable Node Providers from configuration.</param>
/// <param name="LogsView">
/// The WebUI Logs view (its history route and realtime topic) over this runtime's log file. A
/// hosted replica's log is the operator's: it records every tenant the replica serves.
/// </param>
internal sealed record RuntimeCapabilities(
    bool MasterNode,
    bool MainTerminalsAndCode,
    bool StdioMcp,
    bool ClaudeRuntime,
    bool ExecutableProviders,
    bool LogsView
)
{
    /// <summary>
    /// Outbound connections of the runtime (<see cref="Net.EgressHttp"/>): unguarded in file mode,
    /// internal destinations denied for hosted tenants. The hosted entry adds the deployment's
    /// <c>egress</c> rules.
    /// </summary>
    internal Net.EgressPolicy Egress { get; init; } = Net.EgressPolicy.Unguarded;

    /// <summary>
    /// The tenant's limits (<see cref="Foxwarm.Limits.TenantLimits"/>), enforced at the runtime's
    /// admission points; none in file mode. The hosted entry reads the tenant's own.
    /// </summary>
    internal Foxwarm.Limits.TenantLimits? Limits { get; init; }

    internal static RuntimeCapabilities File { get; } = new(true, true, true, true, true, true);

    /// <summary>Hosted: only the deployment's executable Providers; no Logs view (U16(b)).</summary>
    internal static RuntimeCapabilities Hosted { get; } =
        new(false, false, false, false, true, false)
        {
            Egress = Net.EgressPolicy.Hosted(),
            Limits = Foxwarm.Limits.TenantLimits.Defaults,
        };

    /// <summary>
    /// The operator's own tenant: file mode's full set over hosted stores, on a master-host
    /// replica (master, terminals and Code, stdio MCP, the Claude runtime, every deployment
    /// Provider and the Logs view of its own runtime). Its limits are a hosted tenant's (plan P2
    /// §7.2), from its tenant row.
    /// </summary>
    internal static RuntimeCapabilities Operator { get; } =
        new(true, true, true, true, true, true)
        {
            Egress = Net.EgressPolicy.Operator(),
            Limits = Foxwarm.Limits.TenantLimits.Defaults,
        };

    /// <summary>
    /// The capabilities of a hosted tenant's stored profile, with the deployment's
    /// <c>egress</c> rules in the profile's egress policy.
    /// </summary>
    internal static RuntimeCapabilities For(TenantProfile profile, Net.EgressRules? egress = null) =>
        profile switch
        {
            TenantProfile.Hosted => Hosted with { Egress = Net.EgressPolicy.Hosted(egress) },
            TenantProfile.Operator => Operator with { Egress = Net.EgressPolicy.Operator(egress) },
            _ => throw new ArgumentOutOfRangeException(nameof(profile)),
        };

    /// <summary>The error a call targeting the absent <c>master</c> Node fails with.</summary>
    internal static InvalidDataException MasterUnavailable() =>
        new("Node is not available: master");

    /// <summary>
    /// The error a call fails with when it would run on the current Node of a Session that has
    /// none. Without a master Node, an unset current Node still reads as <c>master</c>.
    /// </summary>
    internal static InvalidDataException NoCurrentNode() =>
        new(
            "This Session has no Node. Select one with `ctl node select <node-id>`; `ctl node list` shows the available Nodes."
        );
}
