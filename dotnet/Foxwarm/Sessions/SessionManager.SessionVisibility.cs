using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Session and Agent list visibility is a presentation projection of tool authorization, like the
// Node list. A listed Session or Agent may still reject a call, and a hidden one is hidden only
// because no addressing probe could pass; every use still runs the strict per-call authorization.
internal sealed partial class SessionManager
{
    private sealed record TargetProbe(
        string Name,
        string? Action,
        string Argument,
        IReadOnlySet<string> Known
    );

    private static IReadOnlySet<string> KnownArgs(params string[] keys) =>
        new HashSet<string>(keys, StringComparer.Ordinal);

    // Capabilities that read, message, assign to, stop or rename a Session admit it to a list.
    // Delivery, scheduling, self-maintenance, deletion, moves and parent changes do not.
    private static readonly TargetProbe[] SessionProbes =
    [
        new("session", "status", "sessionId", KnownArgs("action", "sessionId")),
        new("session", "update-display-name", "sessionId", KnownArgs("action", "sessionId")),
        new("view_session", null, "sessionId", KnownArgs("sessionId")),
        new("send_to_session", null, "sessionId", KnownArgs("sessionId")),
        new("recall", null, "sessionId", KnownArgs("sessionId")),
        new("get_archived_messages", null, "sessionId", KnownArgs("sessionId")),
        new("get_archived_blocks", null, "sessionId", KnownArgs("sessionId")),
        new("stop_session", null, "sessionId", KnownArgs("sessionId")),
        new("task", "create", "ownerSessionId", KnownArgs("action", "ownerSessionId")),
        new("task", "assign", "ownerSessionId", KnownArgs("action", "ownerSessionId")),
    ];

    // Actions that name an existing Agent as their object admit it to `list_agents`.
    private static readonly TargetProbe[] AgentProbes =
    [
        new("create_session", null, "agentName", KnownArgs("agentName")),
        new("create_child_session", null, "agentName", KnownArgs("agentName")),
        new("move_session", null, "newAgentName", KnownArgs("newAgentName")),
        new("skill", "list", "agentName", KnownArgs("action", "agentName")),
        new("skill", "load", "agentName", KnownArgs("action", "agentName")),
        new("set_agent_inherit", null, "agentName", KnownArgs("agentName")),
        new("set_agent_rules", null, "agentName", KnownArgs("agentName")),
    ];

    internal SessionListVisibility SessionVisibilityFor(SessionOwner owner, bool memoize = true) =>
        new(this, owner, memoize);

    // One caller's Session and Agent list projection over one policy snapshot. Probe results
    // depend only on a target's relation to the caller (self, parent, child, same Agent) and on
    // which of its spellings a rule names literally, so they are memoized per such class and the
    // cost does not grow with the catalog.
    internal sealed class SessionListVisibility
    {
        // Never equal to a literal in a rule; stands for any target spelling no rule names.
        private const string Unnamed = "\u0000unnamed";
        private const string OtherAgent = "\u0000other-agent";

        private readonly SessionManager manager;
        private readonly ToolVisibilityContext context;
        private readonly bool memoize;
        private readonly string? callerParent;
        private readonly HashSet<string> callerAliases;
        private readonly string callerMain;
        private readonly HashSet<string> literals;
        private readonly Dictionary<string, bool> classes = new(StringComparer.Ordinal);
        private Dictionary<string, int>? hiddenPerAgent;

        internal SessionListVisibility(SessionManager manager, SessionOwner owner, bool memoize)
        {
            this.manager = manager;
            this.memoize = memoize;
            context = manager.VisibilityFor(owner);
            var row = manager.Catalog.Get(owner.Id);
            callerParent = manager.AuthorizationParent(row);
            callerAliases = Strings(row?["aliases"]).ToHashSet(StringComparer.Ordinal);
            callerMain = SessionIdentity.Build(owner.Agent, "main");
            // Reading the policies here makes an unavailable global policy fail the list.
            literals = Literals(context.Policies);
        }

        internal string Caller => context.Session;
        internal string Agent => context.Agent;

        // Number of single-probe policy evaluations, for cost checks.
        internal int Evaluations { get; private set; }

        private static IEnumerable<string> Strings(JsonNode? node) =>
            node is JsonArray list ? list.Select(SessionWait.Text).OfType<string>() : [];

        // Every literal a rule compares a Session target argument with. Other matcher shapes
        // (relationship, existence) behave alike for every spelling no rule names.
        private static HashSet<string> Literals(IEnumerable<ToolAuthorizationPolicy> policies)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            void Add(JsonNode? value)
            {
                if (value is JsonArray list)
                    foreach (var item in list)
                        Add(item);
                else if (SessionWait.Text(value) is string text)
                    result.Add(text);
            }
            foreach (var policy in policies)
            foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
            {
                if (rule["match"]?["args"] is not JsonObject args)
                    continue;
                foreach (var key in new[] { "sessionId", "ownerSessionId" })
                {
                    var matcher = args[key];
                    if (matcher is JsonObject map)
                    {
                        Add(map["equals"]);
                        Add(map["oneOf"]);
                    }
                    else
                        Add(matcher);
                }
            }
            return result;
        }

        private bool Probe(
            TargetProbe probe,
            string value,
            AuthorizationTarget? target,
            string? sourceParent
        )
        {
            if (context.ExternalRuntime && !ClaudeRuntimeToolSupport.Visible("builtin", probe.Name))
                return false;
            var args = new JsonObject();
            if (probe.Action is not null)
                args["action"] = probe.Action;
            args[probe.Argument] = value;
            Evaluations++;
            return manager.VisibleRequest(
                context,
                "builtin",
                probe.Name,
                null,
                args,
                "master",
                null,
                unknownNode: false,
                unknownNodeTargets: false,
                probe.Known,
                target,
                sourceParent
            );
        }

        // Whether any addressing probe might be allowed for one of the target's spellings. The
        // `<parent>` and `<main>` references are spellings only for send_to_session.
        private bool Addressable(
            AuthorizationTarget target,
            IReadOnlyList<string> spellings,
            IReadOnlyList<string> references
        ) =>
            SessionProbes.Any(probe =>
                spellings
                    .Concat(probe.Name == "send_to_session" ? references : [])
                    .Any(value => Probe(probe, value, target, callerParent))
            );

        private bool Child(string? rawParent) =>
            rawParent is not null
            && (
                rawParent == Caller
                || callerAliases.Contains(rawParent)
                    && SessionCatalog.Text(manager.Catalog.Resolve(rawParent)["sessionId"])
                        == Caller
            );

        // Whether a catalog or presentation row is listed for the caller.
        internal bool Admits(JsonObject row)
        {
            var id = SessionCatalog.Text(row["id"]);
            if (id is null)
                return false;
            if (id == Caller)
                return true;
            var parent = callerParent is not null && id == callerParent;
            var references = new List<string>();
            if (parent && literals.Contains("<parent>"))
                references.Add("<parent>");
            if (id == callerMain && literals.Contains("<main>"))
                references.Add("<main>");
            var forms = Strings(row["aliases"]).Prepend(id).Distinct(StringComparer.Ordinal);
            if (!memoize)
            {
                var exact = manager.AuthorizationTarget(id);
                return exact is not null && Addressable(exact, forms.ToArray(), references);
            }
            var agent = SessionCatalog.Text(row["agent"]);
            var named = forms.Where(literals.Contains).Order(StringComparer.Ordinal).ToArray();
            return Class(
                parent,
                Child(SessionCatalog.Text(row["parentSessionId"])),
                agent == Agent,
                named,
                unnamed: forms.Any(form => !literals.Contains(form)),
                references
            );
        }

        private bool Class(
            bool parent,
            bool child,
            bool sameAgent,
            IReadOnlyList<string> named,
            bool unnamed,
            IReadOnlyList<string> references
        )
        {
            var key = string.Join(
                '\u0001',
                new[] { parent ? "p" : "-", child ? "c" : "-", sameAgent ? "a" : "-" }
                    .Concat(unnamed ? ["*"] : [])
                    .Concat(named)
                    .Append("\u0002")
                    .Concat(references)
            );
            if (classes.TryGetValue(key, out var known))
                return known;
            var target = new AuthorizationTarget(
                parent ? callerParent! : Unnamed,
                sameAgent ? Agent : OtherAgent,
                child ? Caller : null
            );
            var spellings = named.Concat(unnamed ? [Unnamed] : []).ToArray();
            return classes[key] = Addressable(target, spellings, references);
        }

        private bool UnrelatedVisible(bool sameAgent) =>
            Class(false, false, sameAgent, [], unnamed: true, []);

        private IEnumerable<bool> SameAgentValues(string? scopeAgent) =>
            scopeAgent is null ? [true, false] : [scopeAgent == Agent];

        // True when some Session outside the explicit set (self, parent, children and Sessions a
        // rule names) might be listed, so the whole scope must be scanned.
        internal bool Broad(string? scopeAgent, bool? sameAgent = null) =>
            SameAgentValues(scopeAgent)
                .Where(value => sameAgent is null || value == sameAgent)
                .Any(UnrelatedVisible);

        // True when every Session in scope is listed, so the unfiltered indexed page applies.
        internal bool Covers(string? scopeAgent)
        {
            foreach (var sameAgent in SameAgentValues(scopeAgent))
                if (
                    !UnrelatedVisible(sameAgent)
                    || !Class(false, true, sameAgent, [], unnamed: true, [])
                )
                    return false;
            return ExplicitRows()
                .Where(row => scopeAgent is null || SessionCatalog.Text(row["agent"]) == scopeAgent)
                .All(Admits);
        }

        private string[]? explicitIds;

        // The only Sessions that can be listed when the unrelated classes are hidden: the caller,
        // its parent and children, and every Session a rule names by ID, alias or reference.
        internal string[] ExplicitIds()
        {
            if (explicitIds is not null)
                return explicitIds;
            var ids = new HashSet<string>(StringComparer.Ordinal) { Caller };
            if (callerParent is not null)
                ids.Add(callerParent);
            var children = manager.Catalog.Count(parent: Caller);
            foreach (
                var row in manager.Catalog.OffsetPage(
                    (int)Math.Min(children + 1, int.MaxValue),
                    0,
                    parent: Caller
                )
            )
                if (SessionCatalog.Text(row["id"]) is string child)
                    ids.Add(child);
            foreach (var literal in literals)
            {
                var resolved = literal switch
                {
                    "<parent>" => callerParent,
                    "<main>" => callerMain,
                    _ => SessionCatalog.Text(manager.Catalog.Resolve(literal)["sessionId"]),
                };
                if (resolved is not null)
                    ids.Add(resolved);
            }
            return explicitIds = ids.ToArray();
        }

        private JsonObject[]? explicitRows;

        // Catalog rows of the explicit set, plus children not yet persisted.
        private JsonObject[] ExplicitRows()
        {
            if (explicitRows is not null)
                return explicitRows;
            var rows = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            foreach (var chunk in ExplicitIds().Chunk(200))
            foreach (var row in manager.Catalog.GetMany(chunk))
                rows[SessionCatalog.Text(row["id"])!] = row;
            foreach (var local in manager.LocalProjections())
                if (
                    SessionCatalog.Text(local["id"]) is string id
                    && !rows.ContainsKey(id)
                    && Child(SessionCatalog.Text(local["parentSessionId"]))
                    && manager.Catalog.Get(id) is null
                )
                    rows[id] = local;
            return explicitRows = rows.Values.ToArray();
        }

        // Listed Sessions of one Agent, given its full Session count. Sessions outside the explicit
        // set all share the Agent's unrelated class.
        internal int ListedCount(string agent, int total)
        {
            hiddenPerAgent ??= ExplicitRows()
                .GroupBy(row => SessionCatalog.Text(row["agent"]) ?? "")
                .ToDictionary(
                    group => group.Key,
                    group => group.Count(row => !Admits(row)),
                    StringComparer.Ordinal
                );
            if (UnrelatedVisible(agent == Agent))
                return Math.Max(0, total - hiddenPerAgent.GetValueOrDefault(agent));
            return ExplicitRows()
                .Count(row => SessionCatalog.Text(row["agent"]) == agent && Admits(row));
        }

        // Whether an Agent-targeted action might be allowed on the Agent, with the structural
        // creator-chain limits the actions themselves apply.
        internal bool AgentAddressable(string agent)
        {
            bool Structural(string name)
            {
                try
                {
                    return name switch
                    {
                        "create_session" or "create_child_session" or "move_session" =>
                            manager.agents.SessionTargetAllowed(Agent, agent),
                        "set_agent_rules" => manager.agents.RulesTargetAllowed(Agent, agent),
                        _ => true,
                    };
                }
                catch (InvalidDataException)
                {
                    return false;
                }
            }
            return AgentProbes.Any(probe =>
                Structural(probe.Name) && Probe(probe, agent, null, callerParent)
            );
        }
    }
}
