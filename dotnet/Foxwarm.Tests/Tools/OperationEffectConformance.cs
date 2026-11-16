using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

/// <summary>
/// Differential conformance between operation plans and handlers (operation authorization
/// phase 3). A case derives the operations of one real call, performs the call, observes what the
/// handler actually did from persisted state, and compares the two:
/// <list type="bullet">
/// <item>every observed effect must be explained by a declared operation of the same kind;</item>
/// <item>every resource the plan states must equal the observed value (Session targets by their
/// canonical ID); a resource the plan leaves null while the handler fixes one is a mismatch
/// unless the case lists it as deferred;</item>
/// <item>every declared side-effect operation must have happened (the call runs with an allow
/// policy, so a declared effect that didn't happen is a false fact), including every declared
/// write destination unless the case marks it as possibly empty;</item>
/// <item>every declared path is canonical; every written file lies inside a declared write leg on
/// the Node it was written on (master, where the harness observes files);</item>
/// <item>a copy is a tree read paired with a tree write: each file of the source as listed before
/// the call must appear with the same bytes at the destination, and every file written under the
/// destination must come from the source. A tree write without its read is an error.</item>
/// </list>
/// Observed effects come from persisted state: Session catalog rows (Agent, Node, runtime,
/// parent), the Agent catalog and metadata (an inheritance it sets is a view of the inherited
/// Agent), Task owners, approved Nodes, the secret store, MCP
/// server configuration, file trees, and channel deliveries a case's transport double observes
/// (the conversation delivered to, compared with the declared `channel.send` resource). To cover another capability, add a <see cref="Case"/> to
/// a case table (ToolAuthorizationEffectsTests.Differential.cs, NodeAuthorizationTreeTests
/// .Differential.cs, AgentRulesTreeTests.Differential.cs); each table also runs whitespace-padded
/// variants of its identifier arguments, which the handler must either reject without effect or
/// perform as planned. To observe another kind of effect, extend <see cref="Take"/> and
/// <see cref="Diff"/>.
/// </summary>
internal static class OperationEffectConformance
{
    /// <summary>
    /// One representative call. Deferred names resources the plan leaves unknown on purpose, as
    /// "op:resource" (a timer Session's Node, decided when it fires). Tasks are Task IDs whose
    /// owner to observe. Probes returns operations a separate authorization probe evaluates for
    /// the call (a timer's creation target); it sees only the case and the caller, never state the
    /// call writes. MayReject lets the handler reject the call, which must then leave no effect.
    /// MayBeEmpty lists declared write destinations the call may legitimately leave unwritten.
    /// </summary>
    internal sealed record Case(
        string Name,
        string Tool,
        JsonObject Args,
        string[]? Deferred = null,
        string[]? Tasks = null,
        Func<Case, SessionOwner, IEnumerable<AuthorizationOperation>>? Probes = null,
        bool MayReject = false,
        string[]? MayBeEmpty = null
    )
    {
        public override string ToString() => Name;
    }

    internal sealed record Effect(string Op, JsonObject Resources);

    internal sealed record Snapshot(
        Dictionary<string, JsonObject> Sessions,
        HashSet<string> Agents,
        Dictionary<string, string> AgentMetadata,
        Dictionary<string, string?> AgentInherit,
        Dictionary<string, string?> Tasks,
        HashSet<string> Nodes,
        Dictionary<string, string> Secrets,
        Dictionary<string, string> Mcp,
        Dictionary<string, string> Files
    );

    // The files of a copy source before the call, by path relative to its root ("." for a file
    // root); null when the source doesn't exist.
    internal sealed record Sources(Dictionary<string, Dictionary<string, string>?> Roots);

    internal static Snapshot Take(
        SessionManager manager,
        IEnumerable<string> tasks,
        IEnumerable<string> roots,
        Foxwarm.Secrets.SecretStore? secrets = null
    )
    {
        var store = secrets ?? manager.Secrets?.Store;
        var metadata = manager.AgentMetadata;
        return new(
            manager
                .Catalog.List()
                .ToDictionary(row => SessionWait.Text(row["id"])!, row => (JsonObject)row.DeepClone()),
            manager.Agents().ToHashSet(StringComparer.Ordinal),
            manager.Agents().ToDictionary(agent => agent, agent => HashText(metadata[agent]?.ToJsonString() ?? "")),
            manager.Agents().ToDictionary(agent => agent, agent => SessionWait.Text(metadata[agent]?["inherit"])),
            tasks.ToDictionary(id => id, id => manager.Tasks.OwnerSessionId(id)),
            manager
                .Nodes.Registry.ListApproved()
                .Select(row => SessionWait.Text(row?["nodeId"]))
                .OfType<string>()
                .ToHashSet(StringComparer.Ordinal),
            // A stored secret by name, with its owner and a hash of its value.
            (store?.List() ?? []).ToDictionary(
                secret => secret.Name,
                secret => store!.Owner(secret.Name) + ":" + HashText(store.Resolve(secret.Name) ?? ""),
                StringComparer.Ordinal
            ),
            manager
                .OutboundMcp.Configuration.Snapshot()
                .ToDictionary(pair => pair.Key, pair => HashText(pair.Value?.ToJsonString() ?? ""), StringComparer.Ordinal),
            roots
                .Where(Directory.Exists)
                .SelectMany(Files)
                .GroupBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First().Value)
        );
    }

    // Files under a root by physical path, with a content hash.
    private static IEnumerable<KeyValuePair<string, string>> Files(string root) =>
        Directory
            .EnumerateFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
            .Select(file => AuthorizationPaths.CanonicalPotential(file))
            .Distinct(StringComparer.Ordinal)
            .Select(file => KeyValuePair.Create(file, Hash(file)));

    private static string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)));

    private static string HashText(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    /// <summary>The copy sources of a plan, listed before the call.</summary>
    internal static Sources ListSources(IReadOnlyList<AuthorizationOperation> declared) =>
        new(
            declared
                .Where(operation => operation is { Op: "env.read", Path: { Tree: true, Resolved: not null } })
                .Select(operation => operation.Path!.Resolved!)
                .Distinct(StringComparer.Ordinal)
                .ToDictionary(
                    root => root,
                    root =>
                        File.Exists(root) ? new Dictionary<string, string> { ["."] = Hash(root) }
                        : Directory.Exists(root)
                            ? Files(root).ToDictionary(pair => Path.GetRelativePath(root, pair.Key), pair => pair.Value)
                        : null
                )
        );

    internal static List<Effect> Diff(Snapshot before, Snapshot after, SessionManager manager)
    {
        var effects = new List<Effect>();
        var removed = before.Sessions.Keys.Except(after.Sessions.Keys).ToList();
        var added = after.Sessions.Keys.Except(before.Sessions.Keys).ToList();
        // A move removes one row and adds one that keeps the old ID as an alias.
        foreach (var id in removed.ToArray())
        {
            var moved = added.FirstOrDefault(candidate =>
                (after.Sessions[candidate]["aliases"] as JsonArray ?? []).Any(alias => SessionWait.Text(alias) == id)
            );
            if (moved is null)
                continue;
            removed.Remove(id);
            added.Remove(moved);
            effects.Add(
                new(
                    "session.manage",
                    new JsonObject
                    {
                        ["targetSession"] = id,
                        ["targetAgent"] = SessionWait.Text(after.Sessions[moved]["agent"]),
                        ["change"] = "move",
                    }
                )
            );
        }
        foreach (var id in removed)
            effects.Add(new("session.manage", new JsonObject { ["targetSession"] = id, ["change"] = "delete" }));
        foreach (var id in added)
        {
            var row = after.Sessions[id];
            effects.Add(
                new(
                    "session.create",
                    new JsonObject
                    {
                        ["targetSession"] = id,
                        ["targetAgent"] = SessionWait.Text(row["agent"]),
                        // The Node the Session executes on (SessionManager.ResolveExecutionNode).
                        ["node"] = row["currentNode"] is null ? null : SessionManager.ResolveExecutionNode(row),
                        ["parent"] = SessionWait.Text(row["parentSessionId"]),
                        ["runtime"] = SessionWait.Text(row["runtime"]) ?? "foxwarm",
                    }
                )
            );
        }
        var newAgents = after.Agents.Except(before.Agents).ToHashSet(StringComparer.Ordinal);
        foreach (var agent in newAgents)
            effects.Add(new("agent.create", new JsonObject { ["targetAgent"] = agent }));
        // Metadata of an Agent the call creates belongs to its creation.
        foreach (var (agent, hash) in after.AgentMetadata)
            if (!newAgents.Contains(agent) && before.AgentMetadata.GetValueOrDefault(agent) != hash)
                effects.Add(new("agent.manage", new JsonObject { ["targetAgent"] = agent }));
        // An inheritance the call sets reads the inherited Agent: an agent.view of it.
        foreach (var (agent, inherit) in after.AgentInherit)
            if (inherit is not null && inherit != before.AgentInherit.GetValueOrDefault(agent))
                effects.Add(new("agent.view", new JsonObject { ["targetAgent"] = inherit, ["inheritedBy"] = agent }));
        foreach (var (task, owner) in after.Tasks)
            if (owner is not null && owner != before.Tasks.GetValueOrDefault(task))
                effects.Add(new("task.assign", new JsonObject { ["task"] = task, ["targetSession"] = owner }));
        foreach (var node in after.Nodes.Except(before.Nodes))
            effects.Add(new("node.trust", new JsonObject { ["node"] = node, ["action"] = "approve" }));
        foreach (var node in before.Nodes.Except(after.Nodes))
            effects.Add(new("node.trust", new JsonObject { ["node"] = node, ["action"] = "revoke" }));
        foreach (var (secret, state) in after.Secrets)
            if (before.Secrets.GetValueOrDefault(secret) != state)
                effects.Add(new("secret.manage", new JsonObject { ["secret"] = secret }));
        foreach (var secret in before.Secrets.Keys.Except(after.Secrets.Keys))
            effects.Add(new("secret.manage", new JsonObject { ["secret"] = secret }));
        foreach (var (server, state) in after.Mcp)
            if (before.Mcp.GetValueOrDefault(server) != state)
                effects.Add(new("mcp.manage", new JsonObject { ["mcp"] = server }));
        foreach (var server in before.Mcp.Keys.Except(after.Mcp.Keys))
            effects.Add(new("mcp.manage", new JsonObject { ["mcp"] = server }));
        // Files are observed on master.
        foreach (var (file, hash) in after.Files)
            if (before.Files.GetValueOrDefault(file) != hash)
                effects.Add(new("env.write", new JsonObject { ["path"] = file, ["node"] = "master", ["hash"] = hash }));
        foreach (var file in before.Files.Keys.Except(after.Files.Keys))
            effects.Add(new("env.write", new JsonObject { ["path"] = file, ["node"] = "master", ["deleted"] = true }));
        return effects;
    }

    // Operations whose effect is persisted and observed; a declared one must have happened.
    private static bool Observable(AuthorizationOperation operation) =>
        operation.Op is "session.create" or "agent.create" or "task.assign" or "secret.manage" or "mcp.manage" or "channel.send"
        || operation.Op == "agent.manage" && SessionWait.Text(operation.With["change"]) is "rules" or "inherit"
        || operation.Op == "session.manage" && SessionWait.Text(operation.With["change"]) is "move" or "delete"
        || operation.Op == "node.trust" && SessionWait.Text(operation.With["action"]) is "approve" or "revoke";

    private static string? Node(AuthorizationOperation operation) =>
        SessionWait.Text(operation.Resources["node"]) ?? operation.Path?.Node;

    /// <summary>Every disagreement between the declared operations and the observed effects.</summary>
    internal static List<string> Compare(
        Case @case,
        IReadOnlyList<AuthorizationOperation> declared,
        List<Effect> observed,
        Sources sources,
        string callerId,
        string callerAgent,
        SessionManager manager
    )
    {
        var problems = new List<string>();
        var deferred = (@case.Deferred ?? []).ToHashSet(StringComparer.Ordinal);
        foreach (var operation in declared.Where(operation => operation.Underivable is not null))
            problems.Add($"{operation.Op}: not derivable ({operation.Underivable})");
        foreach (var operation in declared.Where(operation => operation.Path is not null))
            if (operation.Path!.Resolved is not { } resolved)
                problems.Add($"{operation.Op}: path {operation.Path.Raw} unresolved");
            else if (AuthorizationPaths.CanonicalPotential(resolved) != resolved)
                problems.Add($"{operation.Op}: path {resolved} is not canonical");
            else if (operation.Path.Node is { } pathNode && Node(operation) != pathNode)
                problems.Add($"{operation.Op}: path Node {pathNode} differs from the operation's Node {Node(operation)}");

        // Copies: tree reads paired with tree writes, in declaration order.
        var treeReads = declared.Where(operation => operation is { Op: "env.read", Path.Tree: true }).ToArray();
        var treeWrites = declared.Where(operation => operation is { Op: "env.write", Path.Tree: true }).ToArray();
        if (treeReads.Length != treeWrites.Length)
            problems.Add($"copy: {treeReads.Length} tree read legs for {treeWrites.Length} tree write legs");
        var pairs = treeWrites
            .Select((write, index) => (write, read: index < treeReads.Length ? treeReads[index] : null))
            .ToArray();
        AuthorizationOperation? ReadOf(AuthorizationOperation write) =>
            pairs.First(pair => ReferenceEquals(pair.write, write)).read;
        Dictionary<string, string>? SourceOf(AuthorizationOperation? read) =>
            read?.Path?.Resolved is { } root ? sources.Roots.GetValueOrDefault(root) : null;

        var writes = declared.Where(operation => operation is { Op: "env.write", Path.Resolved: not null }).ToArray();
        var written = new HashSet<AuthorizationOperation>(ReferenceEqualityComparer.Instance);
        var copied = new Dictionary<AuthorizationOperation, HashSet<string>>(ReferenceEqualityComparer.Instance);
        var remaining = declared.Where(operation => operation.Op != "env.write" && Observable(operation)).ToList();
        foreach (var effect in observed)
        {
            if (effect.Op == "env.write")
            {
                var file = SessionWait.Text(effect.Resources["path"])!;
                var node = SessionWait.Text(effect.Resources["node"]);
                var covering = writes
                    .Where(operation => operation.Path!.Tree ? Within(operation.Path.Resolved!, file) : operation.Path.Resolved == file)
                    .ToArray();
                if (covering.Length == 0)
                {
                    if (!CreatedAgentFile(file, observed, manager))
                        problems.Add($"env.write: {file} written without a declared write");
                    continue;
                }
                var leg = covering.FirstOrDefault(operation => Node(operation) == node);
                if (leg is null)
                {
                    problems.Add($"env.write: {file} written on {node}, declared on {string.Join(", ", covering.Select(Node))}");
                    continue;
                }
                written.Add(leg);
                if (!leg.Path!.Tree || effect.Resources["deleted"] is not null)
                    continue;
                var read = ReadOf(leg);
                if (read is null)
                {
                    problems.Add($"env.write: copy destination {leg.Path.Resolved} has no read leg");
                    continue;
                }
                if (Node(read) != node)
                    problems.Add($"env.read: copy source {read.Path!.Resolved} declared on {Node(read)}, read on {node}");
                var relative = Path.GetRelativePath(leg.Path.Resolved!, file);
                var hash = SessionWait.Text(effect.Resources["hash"]);
                if (SourceOf(read)?.GetValueOrDefault(relative) != hash)
                    problems.Add($"env.read: copied {file} doesn't come from {read.Path!.Resolved}/{relative}");
                else
                {
                    if (!copied.TryGetValue(leg, out var set))
                        copied[leg] = set = new(StringComparer.Ordinal);
                    set.Add(relative);
                }
                continue;
            }
            if (effect.Op == "agent.view")
            {
                // Views aren't consumed: one declared view explains every read of its Agent.
                var inherited = SessionWait.Text(effect.Resources["targetAgent"]);
                var views = declared.Where(operation => operation.Op == "agent.view").ToArray();
                if (!views.Any(view => SessionWait.Text(view.Resources["targetAgent"]) == inherited))
                    problems.Add(
                        $"agent.view: inherits {inherited}, declared views of {(views.Length == 0 ? "none" : string.Join(", ", views.Select(view => view.Resources["targetAgent"]?.ToJsonString() ?? "unresolved")))}"
                    );
                continue;
            }
            var candidates = remaining.Where(operation => Kind(operation) == Kind(effect)).ToList();
            if (candidates.Count == 0)
            {
                problems.Add($"{Kind(effect)}: undeclared effect {effect.Resources.ToJsonString()}");
                continue;
            }
            var best = candidates
                .Select(operation => (operation, mismatches: Mismatches(operation, effect, callerId, manager, deferred)))
                .OrderBy(pair => pair.mismatches.Count)
                .First();
            remaining.Remove(best.operation);
            problems.AddRange(best.mismatches.Select(text => $"{Kind(effect)}: {text}"));
        }
        // Each copy carries every file of its source.
        foreach (var (write, read) in pairs)
        {
            if (read is null)
                continue;
            var source = SourceOf(read);
            if (source is null)
            {
                if (!(@case.MayBeEmpty ?? []).Contains(write.Path!.Resolved))
                    problems.Add($"env.read: copy source {read.Path!.Resolved} doesn't exist");
                continue;
            }
            foreach (var relative in source.Keys)
                if (!(copied.GetValueOrDefault(write)?.Contains(relative) ?? false))
                    problems.Add($"env.write: {read.Path!.Resolved}/{relative} not copied to {write.Path!.Resolved}");
        }
        // Declared writes happen, except an empty copy and a destination the case allows empty.
        foreach (var write in writes)
            if (
                !written.Contains(write)
                && !(write.Path!.Tree && ReadOf(write) is { } read && SourceOf(read) is { Count: 0 })
                && !(@case.MayBeEmpty ?? []).Contains(write.Path.Resolved)
            )
                problems.Add($"env.write: declared destination {write.Path.Resolved} on {Node(write)} not written");
        foreach (var operation in remaining)
            problems.Add($"{Kind(operation)}: declared but not performed {operation.Resources.ToJsonString()}");
        // Relation facts the plan states must hold after the call.
        foreach (var operation in declared)
            if (
                operation.AgentDescendant is bool descendant
                && SessionWait.Text(operation.Resources["targetAgent"]) is { } agent
                && manager.Agents().Contains(agent)
                && descendant != Descends(manager, agent, callerAgent)
            )
                problems.Add($"{operation.Op}: targetAgent {agent} descendant={descendant}, actually {!descendant}");
        return problems;
    }

    // Files an Agent creation writes into the new Agent's own directory outside its memory (its
    // prompt files): covered by agent.create.
    private static bool CreatedAgentFile(string file, List<Effect> observed, SessionManager manager) =>
        observed
            .Where(effect => effect.Op == "agent.create")
            .Select(effect => SessionWait.Text(effect.Resources["targetAgent"])!)
            .Any(agent =>
            {
                var directory = AuthorizationPaths.CanonicalPotential(manager.AgentDirectory(agent));
                return Within(directory, file) && !Within(Path.Combine(directory, "memory"), file);
            });

    private static string Kind(AuthorizationOperation operation) =>
        operation.Op switch
        {
            "session.manage" => "session.manage(" + SessionWait.Text(operation.With["change"]) + ")",
            "node.trust" => "node.trust(" + SessionWait.Text(operation.With["action"]) + ")",
            _ => operation.Op,
        };

    private static string Kind(Effect effect) =>
        effect.Op switch
        {
            "session.manage" => "session.manage(" + SessionWait.Text(effect.Resources["change"]) + ")",
            "node.trust" => "node.trust(" + SessionWait.Text(effect.Resources["action"]) + ")",
            _ => effect.Op,
        };

    private static List<string> Mismatches(
        AuthorizationOperation operation,
        Effect effect,
        string callerId,
        SessionManager manager,
        HashSet<string> deferred
    )
    {
        var problems = new List<string>();
        void Equal(string name, JsonNode? declaredValue, string? actual)
        {
            if (declaredValue is null || declaredValue is JsonObject)
            {
                if (actual is not null && declaredValue is null && !deferred.Contains(operation.Op + ":" + name))
                    problems.Add($"{name} undeclared, actually {actual}");
                return;
            }
            var text = SessionWait.Text(declaredValue) ?? declaredValue.ToJsonString();
            if (text != actual)
                problems.Add($"{name} declared {text}, actually {actual ?? "none"}");
        }
        string? Canonical(string? session) =>
            session is null ? null : SessionWait.Text(manager.Catalog.Resolve(session)["sessionId"]) ?? session;
        string? AgentOf(string? session) =>
            session is null ? null : SessionWait.Text(manager.Catalog.Get(session)?["agent"]);
        string? ParentOf(string? session) =>
            session is null ? null : Canonical(SessionWait.Text(manager.Catalog.Get(session)?["parentSessionId"]));
        // A Session reference compares by the canonical ID the matcher sees (its resolved
        // target); a prospective marker by the created Session's Agent, fixed ID and relation.
        void Session(string name, JsonNode? declaredValue, AuthorizationTarget? target, string? actual)
        {
            if (declaredValue is not JsonObject marker || marker["prospective"] is null)
            {
                // Observed IDs come from catalog rows and are canonical already.
                Equal(name, target?.Id is { } id ? JsonValue.Create(id) : declaredValue, actual);
                return;
            }
            var agent = SessionWait.Text(marker["agent"]);
            if (agent is null)
            {
                if (!deferred.Contains(operation.Op + ":" + name + ".agent"))
                    problems.Add($"{name}: new Session's Agent undeclared, actually {AgentOf(actual)}");
            }
            else if (agent != AgentOf(actual))
                problems.Add($"{name}: new Session's Agent declared {agent}, actually {AgentOf(actual)}");
            if (SessionWait.Text(marker["id"]) is { } fixedId && fixedId != actual)
                problems.Add($"{name}: new Session declared {fixedId}, actually {actual}");
            var child = marker["child"]?.GetValue<bool>() == true;
            if (child != (ParentOf(actual) == callerId))
                problems.Add($"{name}: child={child}, actually parent {ParentOf(actual) ?? "none"}");
        }
        var resources = effect.Resources;
        switch (effect.Op)
        {
            case "session.create":
                Session("targetSession", operation.Resources["targetSession"], operation.Target, SessionWait.Text(resources["targetSession"]));
                Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                Equal("node", operation.Resources["node"], SessionWait.Text(resources["node"]));
                Session("parent", operation.Resources["parent"], operation.ParentTarget, SessionWait.Text(resources["parent"]));
                Equal("runtime", operation.With["runtime"], SessionWait.Text(resources["runtime"]));
                break;
            case "session.manage":
                Session("targetSession", operation.Resources["targetSession"], operation.Target, SessionWait.Text(resources["targetSession"]));
                if (resources["targetAgent"] is not null)
                    Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                break;
            case "task.assign":
                Equal("task", operation.Resources["task"], SessionWait.Text(resources["task"]));
                Session("targetSession", operation.Resources["targetSession"], operation.Target, SessionWait.Text(resources["targetSession"]));
                break;
            case "agent.create":
            case "agent.manage":
                Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                break;
            case "node.trust":
                Equal("node", operation.Resources["node"], SessionWait.Text(resources["node"]));
                break;
            case "secret.manage":
                Equal("secret", operation.Resources["secret"], SessionWait.Text(resources["secret"]));
                break;
            case "mcp.manage":
                Equal("mcp", operation.Resources["mcp"], SessionWait.Text(resources["mcp"]));
                break;
            case "channel.send":
                Equal("channel", operation.Resources["channel"], SessionWait.Text(resources["channel"]));
                break;
        }
        return problems;
    }

    private static bool Descends(SessionManager manager, string agent, string caller)
    {
        if (agent == caller)
            return false;
        var metadata = manager.AgentMetadata;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var current = agent; SessionWait.Text(metadata[current]?["createdBy"]) is { } creator && seen.Add(current); current = creator)
            if (creator == caller)
                return true;
        return false;
    }

    private static bool Within(string root, string file) =>
        file == root || file.StartsWith(root.TrimEnd('/') + "/", StringComparison.Ordinal);

    /// <summary>
    /// Runs a case: derives its operations under a policy that has an operation rule (so they are
    /// derived) but decides nothing for these calls, lists copy sources, performs the call, and
    /// compares.
    /// </summary>
    internal static async Task<List<string>> Run(
        Case @case,
        SessionManager manager,
        SessionOwner caller,
        Func<string, JsonObject, Task<AuthorizationAssessment>> assess,
        Func<string, JsonObject, Task<JsonNode?>> perform,
        IEnumerable<string> roots,
        Foxwarm.Secrets.SecretStore? secrets = null,
        Func<IEnumerable<Effect>>? deliveries = null
    )
    {
        var observedRoots = roots.Select(AuthorizationPaths.CanonicalPotential).ToArray();
        var assessment = await assess(@case.Tool, (JsonObject)@case.Args.DeepClone());
        IReadOnlyList<AuthorizationOperation> declared = assessment.Request.Operations ?? [];
        // Operations authorized by a separate probe join the plan, derived before the call.
        if (@case.Probes is { } probes)
            declared = declared.Concat(probes(@case, caller)).ToArray();
        var problems = new List<string>();
        if (assessment.Effect != ToolAuthorizationEffect.Allow && !@case.MayReject)
            problems.Add($"assessment {assessment.Effect}: {assessment.Request.Operations?.Count ?? 0} operations");
        var callerAgent = caller.Agent;
        var callerId = caller.Id;
        var sources = ListSources(declared);
        var before = Take(manager, @case.Tasks ?? [], observedRoots, secrets);
        var result = await perform(@case.Tool, (JsonObject)@case.Args.DeepClone());
        var after = Take(manager, @case.Tasks ?? [], observedRoots, secrets);
        var effects = Diff(before, after, manager);
        // Channel deliveries as the transport's test double observed them, as
        // channel.send {channel: instance:conversation delivered to}.
        if (deliveries is not null)
            effects.AddRange(deliveries());
        if (result?["error"] is { } error)
        {
            if (!@case.MayReject)
                problems.Add("call failed: " + error.ToJsonString());
            else
                problems.AddRange(effects.Select(effect => $"rejected call left {effect.Op} {effect.Resources.ToJsonString()}"));
            return problems;
        }
        problems.AddRange(Compare(@case, declared, effects, sources, callerId, callerAgent, manager));
        return problems;
    }

    /// <summary>A policy with an operation rule for no call these cases make.</summary>
    internal const string Policy = "version: 1\nrules:\n- {op: mcp.call, mcp: {server: differential-none}, action: deny}\n";

    // Arguments naming an identifier (Agent, Session, Task, Node, secret, server, channel), which
    // padded variants surround with whitespace.
    private static readonly string[] Identifiers =
    [
        "agentName",
        "sessionName",
        "sessionId",
        "newSessionId",
        "parentSessionId",
        "sourceSessionId",
        "newAgentName",
        "inherit",
        "inheritAgentName",
        "taskId",
        "ownerSessionId",
        "nodeId",
        "pendingId",
        "name",
        "server",
        "channelTargetId",
        "defaultNode",
        "node",
    ];

    /// <summary>
    /// Whitespace-padded variants of a case, one per identifier argument it has. The handler must
    /// reject a variant without effect or perform it exactly as its own plan states.
    /// </summary>
    internal static IEnumerable<Case> Padded(Case @case) =>
        Identifiers
            .Where(key => @case.Args[key] is JsonValue value && value.TryGetValue<string>(out _))
            .Select(key =>
            {
                var args = (JsonObject)@case.Args.DeepClone();
                args[key] = " " + SessionWait.Text(args[key]) + " ";
                return @case with { Name = @case.Name + " [padded " + key + "]", Args = args, MayReject = true };
            });
}
