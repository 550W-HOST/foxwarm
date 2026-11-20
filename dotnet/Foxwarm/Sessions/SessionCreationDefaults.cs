using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// The values Session- and Agent-creating handlers resolve when an argument is omitted: target
/// Agents, Nodes, source Sessions and runtimes. Handlers apply these functions, and the
/// operation plan (<c>OperationPlan</c>) calls the same functions for its authorization facts, so
/// a fact is the value the handler will apply rather than a parallel reimplementation.
/// </summary>
internal static class SessionCreationDefaults
{
    // create_child_session: the named Agent, else the parent's.
    internal static string ChildAgent(string? agentName, string parentAgent) =>
        agentName ?? parentAgent;

    // The Node a creation passes to the Session it creates: an explicit Node, else the current
    // Node of a parent in the same Agent. Null leaves placement to the target Agent's default.
    // An explicit creation Node argument as the creation stores it: trimmed, as execution reads
    // a Session's Node (SessionManager.ResolveExecutionNode).
    internal static string? ExplicitNode(string? argument) =>
        argument is null ? null : SessionGoal.Trim(argument);

    internal static string? InitialNode(
        string? explicitNode,
        string targetAgent,
        string parentAgent,
        string? parentNode
    ) => explicitNode ?? (targetAgent == parentAgent ? parentNode : null);

    // The Node a new Session starts on: its initial Node, else the Agent's effective default,
    // else master.
    internal static string PlacedNode(string? initialNode, string? effectiveAgentDefault) =>
        initialNode ?? effectiveAgentDefault ?? "master";

    // An Agent's effective default Node: its own default, else the installation default.
    internal static string? EffectiveDefaultNode(string? agentDefault, string? installDefault) =>
        agentDefault ?? installDefault;

    // create_agent's source Session: the named Session, else the caller. Caller is true when the
    // caller is the source.
    internal static (string Id, bool Caller) CreationSource(
        string? sourceSessionId,
        string callerId
    ) =>
        string.IsNullOrEmpty(sourceSessionId) ? (callerId, true) : (sourceSessionId, false);

    // The Agent of a source Session: an existing Session's Agent, else the Agent its ID names
    // (the creation makes it there).
    internal static string? SourceAgent(string id, string? existingAgent) =>
        existingAgent ?? (SessionIdentity.IsValid(id) ? SessionIdentity.Agent(id) : null);

    // The Agent whose memory an Agent creation copies: the source Session's, else main's.
    internal static string MemorySourceAgent(string? sourceAgent) => sourceAgent ?? "main";

    // The main Session of an Agent.
    internal static string MainSession(string agentName) => SessionIdentity.Build(agentName, "main");

    // move_session's target Agent: the new Agent when one is named or created, else the moved
    // Session's own. Null when an Agent is to be created without a name.
    internal static string? MoveTargetAgent(string? newAgentName, bool createAgent, string movedAgent) =>
        createAgent || !string.IsNullOrEmpty(newAgentName) ? newAgentName : movedAgent;

    // A creation's runtime: the selected one, else foxwarm.
    internal static string Runtime(JsonNode? value, bool present) =>
        ClaudeRuntimeState.ValidateSelection(value, present);
}
