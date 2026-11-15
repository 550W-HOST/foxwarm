using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Facts operation rules read beyond the request (phase 3 of operation authorization): the
// operations of a call with their resolved Sessions, Agent ancestry, Task authority and secret
// ownership, from catalog and store lookups. Nothing here hydrates a Session or reads a
// protected file.
internal sealed partial class SessionManager
{
    internal IReadOnlyList<AuthorizationOperation> AuthorizationOperations(
        SessionOwner owner,
        ResolvedTool resolved,
        ToolAuthorizationRequest request
    )
    {
        var context = new PlanContext(CurrentNode(owner))
        {
            PolicyPath = authorization.PolicyPath,
            SessionExists = id => AuthorizationTarget(id) is not null,
            SessionAgent = id => AuthorizationTarget(id)?.Agent,
            MemoryDirectory = agent =>
            {
                try
                {
                    return agents.MemoryDirectory(agent);
                }
                catch (Exception error) when (error is InvalidDataException or ArgumentException)
                {
                    return null;
                }
            },
        };
        return OperationPlan
            .AuthorizationOperations(resolved, request, context)
            .Select(operation => WithFacts(owner, operation, request))
            .ToArray();
    }

    private AuthorizationOperation WithFacts(
        SessionOwner owner,
        AuthorizationOperation operation,
        ToolAuthorizationRequest request
    )
    {
        if (operation.Underivable is not null)
            return operation;
        AuthorizationTarget? Resolve(string? reference)
        {
            if (string.IsNullOrWhiteSpace(reference))
                return null;
            try
            {
                return AuthorizationTarget(SessionGoal.Trim(reference));
            }
            catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
            {
                return null;
            }
        }
        if (operation.Target is null && SessionWait.Text(operation.Resources["targetSession"]) is { } target)
            operation = operation with { Target = Resolve(target) };
        if (SessionWait.Text(operation.Resources["parent"]) is { } parent)
            operation = operation with { ParentTarget = Resolve(parent) };
        if (SessionWait.Text(operation.Resources["targetAgent"]) is { } agent)
            operation = operation with { AgentDescendant = Descendant(owner.Agent, agent, operation.Op) };
        if (SessionWait.Text(operation.Resources["task"]) is { } task && task.Length <= 128)
        {
            var id = task.Trim();
            string? Canonical(string? session) =>
                session is null ? null : SessionCatalog.Text(Catalog.Resolve(session)["sessionId"]) ?? session;
            try
            {
                var exists = Tasks.OwnerSessionId(id) is not null || Tasks.CreatorSessionId(id) is not null;
                operation = operation with
                {
                    TaskOwned = exists ? Canonical(Tasks.OwnerSessionId(id)) == owner.Id : null,
                    TaskCreated = exists ? Canonical(Tasks.CreatorSessionId(id)) == owner.Id : null,
                };
            }
            catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
            {
                // The Task facts stay unknown.
            }
        }
        if (SessionWait.Text(operation.Resources["secret"]) is { } secret)
            operation = operation with
            {
                SecretOwned = OwnedSecrets(owner.Agent, [secret]).Count > 0,
            };
        return operation;
    }

    // Whether an Agent is a strict creator descendant of the caller's Agent; a new Agent is
    // created as one. Unknown when the target's creator chain is invalid.
    private bool? Descendant(string caller, string agent, string op)
    {
        if (op == "agent.create")
            return true;
        if (agent == caller)
            return false;
        try
        {
            return agents.Exists(agent)
                && agents.CreatorChainOf(agent).Contains(caller, StringComparer.Ordinal);
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }
}
