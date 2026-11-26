namespace Foxwarm;

/// <summary>
/// The features a runtime has, fixed when it is built. File mode has all of them. A hosted
/// replica runs in a container with no local execution environment for Agents, so it has no
/// <c>master</c> Node, no Main-local terminals or Code, no stdio MCP servers and no Claude
/// runtime; its executable Providers are the deployment configuration's <c>nodeProviders</c>.
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
internal sealed record RuntimeCapabilities(
    bool MasterNode,
    bool MainTerminalsAndCode,
    bool StdioMcp,
    bool ClaudeRuntime,
    bool ExecutableProviders
)
{
    internal static RuntimeCapabilities File { get; } = new(true, true, true, true, true);

    /// <summary>Hosted P1: only the deployment's executable Providers.</summary>
    internal static RuntimeCapabilities Hosted { get; } = new(false, false, false, false, true);

    /// <summary>The error a call targeting the absent <c>master</c> Node fails with.</summary>
    internal static InvalidDataException MasterUnavailable() =>
        new("Node is not available: master");
}
