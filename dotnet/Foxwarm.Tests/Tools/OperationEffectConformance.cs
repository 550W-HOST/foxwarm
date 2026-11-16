using System.Security.Cryptography;
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
/// <item>every resource the plan states must equal the observed value; a resource the plan leaves
/// null while the handler fixes one is a mismatch unless the case lists it as deferred;</item>
/// <item>every declared side-effect operation must have happened (the call runs with an allow
/// policy, so a declared effect that didn't happen is a false fact);</item>
/// <item>every declared path is canonical, written files lie inside a declared write leg, and a
/// copy's written bytes equal the file at the same place under its declared read leg.</item>
/// </list>
/// Observed effects come from persisted state: Session catalog rows (Agent, Node, runtime,
/// parent), the Agent catalog and creator metadata, Task owners, approved Nodes, the secret
/// store, and file trees. To cover another capability, add a <see cref="Case"/> to a case list
/// (ToolAuthorizationEffectsTests.Differential.cs or NodeAuthorizationTreeTests.Differential.cs);
/// to observe another kind of effect, extend <see cref="Take"/> and <see cref="Diff"/>.
/// </summary>
internal static class OperationEffectConformance
{
    /// <summary>
    /// One representative call. Deferred names resources the plan leaves unknown on purpose, as
    /// "op:resource" (for example a timer Session's Node, decided when it fires). Tasks are Task
    /// IDs whose owner to observe. Probes adds operations a separate authorization probe
    /// evaluates for the call (a timer's creation target), derived after the call.
    /// </summary>
    internal sealed record Case(
        string Name,
        string Tool,
        JsonObject Args,
        string[]? Deferred = null,
        string[]? Tasks = null,
        Func<SessionManager, SessionOwner, IEnumerable<AuthorizationOperation>>? Probes = null
    )
    {
        public override string ToString() => Name;
    }

    internal sealed record Effect(string Op, JsonObject Resources);

    internal sealed record Snapshot(
        Dictionary<string, JsonObject> Sessions,
        HashSet<string> Agents,
        Dictionary<string, string?> Tasks,
        HashSet<string> Nodes,
        Dictionary<string, string> Secrets,
        Dictionary<string, string> Files
    );

    internal static Snapshot Take(
        SessionManager manager,
        IEnumerable<string> tasks,
        IEnumerable<string> roots,
        Foxwarm.Secrets.SecretStore? secrets = null
    ) =>
        new(
            manager
                .Catalog.List()
                .ToDictionary(row => SessionWait.Text(row["id"])!, row => (JsonObject)row.DeepClone()),
            manager.Agents().ToHashSet(StringComparer.Ordinal),
            tasks.ToDictionary(id => id, id => manager.Tasks.OwnerSessionId(id)),
            manager
                .Nodes.Registry.ListApproved()
                .Select(row => SessionWait.Text(row?["nodeId"]))
                .OfType<string>()
                .ToHashSet(StringComparer.Ordinal),
            // A stored secret by name, with its owner and a hash of its value.
            ((secrets ?? manager.Secrets?.Store)?.List() ?? [])
                .ToDictionary(
                    secret => secret.Name,
                    secret =>
                    {
                        var store = (secrets ?? manager.Secrets?.Store)!;
                        return store.Owner(secret.Name)
                            + ":"
                            + Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(store.Resolve(secret.Name) ?? "")));
                    },
                    StringComparer.Ordinal
                ),
            roots
                .Where(Directory.Exists)
                .SelectMany(Files)
                .GroupBy(pair => pair.Key, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First().Value)
        );

    // Files under a root by physical path, with a content hash.
    private static IEnumerable<KeyValuePair<string, string>> Files(string root) =>
        Directory
            .EnumerateFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
            .Select(file => AuthorizationPaths.CanonicalPotential(file))
            .Distinct(StringComparer.Ordinal)
            .Select(file => KeyValuePair.Create(file, Hash(file)));

    private static string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)));

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
                        ["node"] = SessionWait.Text(row["currentNode"]),
                        ["parent"] = SessionWait.Text(row["parentSessionId"]),
                        ["runtime"] = SessionWait.Text(row["runtime"]) ?? "foxwarm",
                    }
                )
            );
        }
        foreach (var agent in after.Agents.Except(before.Agents))
            effects.Add(new("agent.create", new JsonObject { ["targetAgent"] = agent }));
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
        foreach (var (file, hash) in after.Files)
            if (before.Files.GetValueOrDefault(file) != hash)
                effects.Add(new("env.write", new JsonObject { ["path"] = file, ["hash"] = hash }));
        foreach (var file in before.Files.Keys.Except(after.Files.Keys))
            effects.Add(new("env.write", new JsonObject { ["path"] = file, ["deleted"] = true }));
        return effects;
    }

    // Operations whose effect is persisted and observed; a declared one must have happened.
    private static bool Observable(AuthorizationOperation operation) =>
        operation.Op is "session.create" or "agent.create" or "task.assign" or "secret.manage" or "env.write"
        || operation.Op == "session.manage" && SessionWait.Text(operation.With["change"]) is "move" or "delete"
        || operation.Op == "node.trust" && SessionWait.Text(operation.With["action"]) is "approve" or "revoke";

    /// <summary>Every disagreement between the declared operations and the observed effects.</summary>
    internal static List<string> Compare(
        Case @case,
        IReadOnlyList<AuthorizationOperation> declared,
        List<Effect> observed,
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
        var remaining = declared.Where(Observable).ToList();
        var reads = declared.Where(operation => operation is { Op: "env.read", Path.Tree: true }).ToArray();
        foreach (var effect in observed)
        {
            if (effect.Op == "env.write")
            {
                var file = SessionWait.Text(effect.Resources["path"])!;
                var leg = remaining
                    .Concat(declared)
                    .FirstOrDefault(operation =>
                        operation is { Op: "env.write", Path.Resolved: { } root }
                        && (operation.Path.Tree ? Within(root, file) : root == file)
                    );
                if (leg is null)
                {
                    if (!CreatedAgentFile(file, observed, manager))
                        problems.Add($"env.write: {file} written without a declared write");
                    continue;
                }
                remaining.Remove(leg);
                if (leg.Path!.Tree && reads.Length > 0 && effect.Resources["deleted"] is null)
                {
                    var relative = Path.GetRelativePath(leg.Path.Resolved!, file);
                    var hash = SessionWait.Text(effect.Resources["hash"]);
                    var source = reads
                        .Select(read => relative == "." ? read.Path!.Resolved! : Path.Combine(read.Path!.Resolved!, relative))
                        .FirstOrDefault(path => File.Exists(path) && Hash(path) == hash);
                    if (source is null)
                        problems.Add($"env.read: copied {file} matches no file under a declared read leg");
                }
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
        // A tree write leg of a copy whose source is empty writes nothing; others must happen.
        foreach (var operation in remaining.Where(operation => !(operation.Op == "env.write" && operation.Path?.Tree == true)))
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
        string? AgentOf(string? session) =>
            session is null ? null : SessionWait.Text(manager.Catalog.Get(session)?["agent"]);
        string? ParentOf(string? session) =>
            session is null ? null : SessionWait.Text(manager.Catalog.Get(session)?["parentSessionId"]);
        // A Session target: an ID, or a prospective marker with the created Session's Agent,
        // fixed ID and child relation.
        void Session(string name, JsonNode? declaredValue, string? actual)
        {
            if (declaredValue is not JsonObject marker || marker["prospective"] is null)
            {
                Equal(name, declaredValue, actual);
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
            if (SessionWait.Text(marker["id"]) is { } id && id != actual)
                problems.Add($"{name}: new Session declared {id}, actually {actual}");
            var child = marker["child"]?.GetValue<bool>() == true;
            if (child != (ParentOf(actual) == callerId))
                problems.Add($"{name}: child={child}, actually parent {ParentOf(actual) ?? "none"}");
        }
        var resources = effect.Resources;
        switch (effect.Op)
        {
            case "session.create":
                Session("targetSession", operation.Resources["targetSession"], SessionWait.Text(resources["targetSession"]));
                Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                Equal("node", operation.Resources["node"], SessionWait.Text(resources["node"]));
                Equal("parent", operation.Resources["parent"], SessionWait.Text(resources["parent"]));
                Equal("runtime", operation.With["runtime"], SessionWait.Text(resources["runtime"]));
                break;
            case "session.manage":
                Equal("targetSession", operation.Resources["targetSession"], SessionWait.Text(resources["targetSession"]));
                if (resources["targetAgent"] is not null)
                    Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                break;
            case "task.assign":
                Equal("task", operation.Resources["task"], SessionWait.Text(resources["task"]));
                Session("targetSession", operation.Resources["targetSession"], SessionWait.Text(resources["targetSession"]));
                break;
            case "agent.create":
                Equal("targetAgent", operation.Resources["targetAgent"], SessionWait.Text(resources["targetAgent"]));
                break;
            case "node.trust":
                Equal("node", operation.Resources["node"], SessionWait.Text(resources["node"]));
                break;
            case "secret.manage":
                Equal("secret", operation.Resources["secret"], SessionWait.Text(resources["secret"]));
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
    /// derived) but decides nothing for these calls, performs the call, and compares.
    /// </summary>
    internal static async Task<List<string>> Run(
        Case @case,
        SessionManager manager,
        SessionOwner caller,
        Func<string, JsonObject, Task<AuthorizationAssessment>> assess,
        Func<string, JsonObject, Task<JsonNode?>> perform,
        IEnumerable<string> roots,
        Foxwarm.Secrets.SecretStore? secrets = null
    )
    {
        var observedRoots = roots.Select(AuthorizationPaths.CanonicalPotential).ToArray();
        var assessment = await assess(@case.Tool, (JsonObject)@case.Args.DeepClone());
        var declared = assessment.Request.Operations ?? [];
        var problems = new List<string>();
        if (assessment.Effect != ToolAuthorizationEffect.Allow)
            problems.Add($"assessment {assessment.Effect}: {assessment.Request.Operations?.Count ?? 0} operations");
        var before = Take(manager, @case.Tasks ?? [], observedRoots, secrets);
        // The caller's Agent before the call (a conversion moves the caller).
        var callerAgent = caller.Agent;
        var callerId = caller.Id;
        var result = await perform(@case.Tool, (JsonObject)@case.Args.DeepClone());
        if (result?["error"] is { } error)
        {
            problems.Add("call failed: " + error.ToJsonString());
            return problems;
        }
        var after = Take(manager, @case.Tasks ?? [], observedRoots, secrets);
        // Operations authorized by a separate probe (a timer's creation target) join the plan.
        if (@case.Probes is { } probes)
            declared = declared.Concat(probes(manager, caller)).ToArray();
        problems.AddRange(Compare(@case, declared, Diff(before, after, manager), callerId, callerAgent, manager));
        return problems;
    }

    /// <summary>A policy with an operation rule for no call these cases make.</summary>
    internal const string Policy = "version: 1\nrules:\n- {op: mcp.call, mcp: {server: differential-none}, action: deny}\n";
}
