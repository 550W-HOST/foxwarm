using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly ToolAuthorizationAuthority authorization;
    private readonly string toolWorkspace;
    internal ToolAuthorizationAuthority Authorization => authorization;

    internal AgentIsolation Isolation(string agent) =>
        IsolatedToolCompatibility.Metadata(agents.MetadataSnapshot()[agent]);

    internal string? RecordedIsolationNode(string agent) => Isolation(agent).RecordedNode;

    internal bool AgentIsolated(string agent) => Isolation(agent).Isolated;

    private string? AuthorizationParent(JsonObject? row)
    {
        var raw = SessionCatalog.Text(row?["parentSessionId"]);
        if (raw is null)
            return null;
        return SessionCatalog.Text(Catalog.Resolve(raw)["sessionId"]) ?? raw;
    }

    internal AuthorizationTarget? AuthorizationTarget(string requested)
    {
        var id = SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"]);
        var row = id is null ? null : Catalog.Get(id);
        return
            row is null
            || SessionCatalog.Text(row["agent"]) is not string agent
            || agent.Length == 0
            ? null
            : new(id!, agent, AuthorizationParent(row));
    }

    private ToolAuthorizationRequest AuthorizationRequest(
        SessionOwner owner,
        string source,
        string name,
        string? server,
        JsonObject args,
        IReadOnlyList<AuthorizationPath> paths
    ) =>
        new(
            source,
            name,
            server,
            args,
            paths,
            owner.Agent,
            owner.Id,
            "master",
            toolWorkspace,
            agents.AgentDirectory(owner.Agent),
            agents.MemoryDirectory(owner.Agent)
        );

    private ToolAuthorizationRequest PopulateAuthorizationTargets(
        ToolAuthorizationRequest request,
        SessionOwner owner
    )
    {
        var parent = AuthorizationParent(Catalog.Get(owner.Id));
        string? requested = SessionWait.Text(request.Args["sessionId"]);
        requested = requested is null ? null : SessionGoal.Trim(requested);
        if (requested is "")
            requested = null;
        if (
            request.Source != "builtin"
            || !ToolAuthorizationPolicy.TargetFamilies.TryGetValue(request.Name, out var family)
        )
            return request with { SourceParent = parent };
        if (family == "send")
        {
            if (requested is null)
                return request with { SourceParent = parent };
            try
            {
                requested = ResolveSessionReference(owner, requested);
            }
            catch (InvalidDataException)
            {
                return request with { SourceParent = parent };
            }
        }
        else if (family == "file")
        {
            if (
                SessionWait.Text(request.Args["channelTargetId"]) is string channel
                && SessionGoal.Trim(channel).Length > 0
            )
                return request with { SourceParent = parent };
            requested ??= owner.Id;
        }
        else if (family == "required")
        {
            if (requested is null)
                return request with { SourceParent = parent };
        }
        else if (family == "recall")
        {
            if (
                requested is null
                && SessionWait.Text(request.Args["vector_query"]) is string vector
                && SessionGoal.Trim(vector).Length > 0
                && SessionWait.Text(request.Args["scope"]) != "current-session"
            )
                return request with { SourceParent = parent };
            requested ??= owner.Id;
        }
        else
            requested ??= owner.Id;
        return request with
        {
            SourceParent = parent,
            SessionTarget = AuthorizationTarget(requested),
        };
    }

    internal async Task AuthorizeToolAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        CancellationToken token,
        SessionOwner? concreteTarget = null
    )
    {
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
        var paths =
            resolved.Source == "node"
                && resolved.Name is "read" or "write" or "edit" or "apply_patch" or "exec"
            || resolved.Source == "builtin"
                && resolved.Name
                    is "set_tool_rules"
                        or "send_file"
                        or "image_write_to_file"
                        or "run_script"
                        or "start_toolscript_run"
                ? (
                    files
                    ?? throw new NotSupportedException(
                        "This executor has no physical path resolver."
                    )
                ).AuthorizationFacts(resolved.Name, resolved.Args)
            : resolved.Source == "builtin"
            && resolved.Name
                is "read_memory"
                    or "write_memory"
                    or "edit_memory"
                    or "delete_memory"
                    or "apply_patch_memory"
                ? MemoryTools.AuthorizationFacts(this, owner, resolved.Name, resolved.Args)
            : [];
        var request = AuthorizationRequest(
            owner,
            resolved.Source,
            resolved.Name,
            resolved.Server,
            resolved.Args,
            paths
        );
        var policy = await authorization.LoadAsync(token);
        if (concreteTarget is not null)
        {
            if (!IsCurrentOwner(concreteTarget))
                throw new InvalidOperationException(
                    "Tool target is no longer the current Session owner."
                );
            request = request with
            {
                SourceParent = AuthorizationParent(Catalog.Get(owner.Id)),
                SessionTarget = new(
                    concreteTarget.Id,
                    concreteTarget.Agent,
                    AuthorizationParent(Catalog.Get(concreteTarget.Id))
                ),
            };
        }
        else if (ToolAuthorizationEvaluation.NeedsTarget(policy, request))
            request = PopulateAuthorizationTargets(request, owner);
        var decision = ToolAuthorizationEvaluation.Evaluate(policy, request);
        if (!decision.Allowed)
            throw new ToolAuthorizationDeniedException(
                SessionWait.Text(decision.Rule?["reason"])
                    ?? $"Tool authorization rule denies {resolved.Source} capability `{resolved.Name}`."
            );
        IsolatedToolCompatibility.Check(Isolation(owner.Agent), request, AuthorizationTarget);
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
    }

    internal bool ToolVisible(
        SessionOwner owner,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false
    )
    {
        if (name == "call_tool" && source == "builtin")
            return true;
        var request = AuthorizationRequest(owner, source, name, server, new(), []);
        return ToolAuthorizationEvaluation.Visible(authorization.Load(), request, unknownNode)
            && IsolatedToolCompatibility.Visible(
                Isolation(owner.Agent),
                source,
                name,
                server,
                unknownNode
            );
    }

    internal JsonArray ModelDefinitions(SessionOwner owner, JsonArray? explicitOverride = null)
    {
        if (explicitOverride is not null)
            return (JsonArray)explicitOverride.DeepClone();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Model request source is no longer the current Session owner."
            );
        return new JsonArray(
            tools
                .Entries.Where(entry =>
                    entry.DefaultInject
                    && ToolVisible(owner, entry.Source, SessionWait.Text(entry.Definition["name"])!)
                )
                .Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition))
                .ToArray()
        );
    }

    internal async Task<JsonObject> InstallToolRulesAsync(
        SessionOwner owner,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["filePath"]);
        var path = ToolRegistry.Text(args, "filePath");
        if (
            path is null
            || SessionGoal.Trim(path).Length == 0
            || Encoding.UTF8.GetByteCount(path) > 4096
        )
            throw new InvalidDataException(
                "set_tool_rules requires one nonempty filePath within 4096 UTF-8 bytes."
            );
        await AuthorizeToolAsync(
            owner,
            new("set_tool_rules", "builtin", "set_tool_rules", args),
            files,
            token
        );
        await AuthorizeToolAsync(owner, new("set_tool_rules", "node", "read", args), files, token);
        var bytes = await files.CapturePolicyCandidateAsync(path, token);
        await authorization.InstallAsync(bytes, token);
        return new JsonObject
        {
            ["output"] = "Tool authorization policy validated and atomically replaced.",
        };
    }
}
