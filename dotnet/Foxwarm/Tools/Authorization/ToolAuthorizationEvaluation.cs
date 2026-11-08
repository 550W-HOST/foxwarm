using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal readonly record struct AuthorizationFact(bool Present, JsonNode? Value)
{
    internal static AuthorizationFact Of(string? value) =>
        new(value is not null, JsonValue.Create(value));
}

internal sealed record AuthorizationTarget(string Id, string Agent, string? Parent);

internal sealed record AuthorizationPath(
    string Arg,
    string Raw,
    string? Resolved,
    string Node = "master"
);

internal sealed record ToolAuthorizationRequest(
    string Source,
    string Name,
    string? Server,
    JsonObject Args,
    IReadOnlyList<AuthorizationPath> Paths,
    string? Agent,
    string? Session,
    string? TargetNode,
    string Workspace,
    string? AgentDirectory,
    string? MemoryDirectory,
    string? SourceParent = null,
    AuthorizationTarget? SessionTarget = null,
    string Principal = "internal",
    string? ExternalId = null,
    string? TaskOwnerSession = null,
    IReadOnlyList<string>? NodeTargets = null,
    string? CurrentNode = null,
    Foxwarm.Nodes.NodeAuthorizationForest? NodeForest = null
);

internal enum ToolAuthorizationEffect
{
    Allow,
    Ask,
    Deny,
}

// Allowed means the call proceeds without a person. Consumers that cannot ask anyone read only
// Allowed and therefore treat Ask as a denial.
internal sealed record AuthorizationDecision(ToolAuthorizationEffect Effect, JsonObject? Rule)
{
    internal bool Allowed => Effect == ToolAuthorizationEffect.Allow;

    internal static ToolAuthorizationEffect Parse(string? action) =>
        action switch
        {
            "allow" => ToolAuthorizationEffect.Allow,
            "ask" => ToolAuthorizationEffect.Ask,
            _ => ToolAuthorizationEffect.Deny,
        };

    internal static string Name(ToolAuthorizationEffect effect) =>
        effect switch
        {
            ToolAuthorizationEffect.Allow => "allow",
            ToolAuthorizationEffect.Ask => "ask",
            _ => "deny",
        };
}

// Layer is null for the global policy, otherwise the Agent that owns the local rules.
internal sealed record AuthorizationLayerDecision(
    string? Layer,
    ToolAuthorizationPolicy Policy,
    AuthorizationDecision Decision
);

internal sealed record AuthorizationAssessment(
    ToolAuthorizationRequest Request,
    IReadOnlyList<AuthorizationLayerDecision> Layers
)
{
    internal AuthorizationLayerDecision? Denied =>
        Layers.FirstOrDefault(layer => layer.Decision.Effect == ToolAuthorizationEffect.Deny);

    internal IReadOnlyList<AuthorizationLayerDecision> Asking =>
        Layers.Where(layer => layer.Decision.Effect == ToolAuthorizationEffect.Ask).ToArray();

    // Deny in any layer wins; otherwise any asking layer requires approval.
    internal ToolAuthorizationEffect Effect =>
        Denied is not null ? ToolAuthorizationEffect.Deny
        : Asking.Count > 0 ? ToolAuthorizationEffect.Ask
        : ToolAuthorizationEffect.Allow;

    internal ToolApprovalOptions Approval => ToolApprovalOptions.Combine(Asking);
}

// Combined options of every asking layer: the shortest deadline, and only identities that every
// asking layer admits. The administrator may always decide.
internal sealed record ToolApprovalOptions(long? TimeoutSeconds, IReadOnlyList<string> Approvers)
{
    internal static ToolApprovalOptions Combine(IEnumerable<AuthorizationLayerDecision> asking)
    {
        long? timeout = null;
        HashSet<string>? approvers = null;
        foreach (var layer in asking)
        {
            var approval = layer.Decision.Rule?["approval"] as JsonObject;
            if (SessionWait.Number(approval?["timeoutSeconds"]) is double seconds)
                timeout = timeout is long current
                    ? Math.Min(current, (long)seconds)
                    : (long)seconds;
            var admitted = SessionWait
                .Strings(approval?["approvers"])
                .ToHashSet(StringComparer.Ordinal);
            if (approvers is null)
                approvers = admitted;
            else
                approvers.IntersectWith(admitted);
        }
        return new(timeout, (approvers ?? []).Order(StringComparer.Ordinal).ToArray());
    }

    internal JsonObject ToJson()
    {
        var result = new JsonObject
        {
            ["approvers"] = new JsonArray(
                Approvers.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
        };
        if (TimeoutSeconds is long seconds)
            result["timeoutSeconds"] = seconds;
        return result;
    }
}

internal enum CreationTargetDecision
{
    Allow,
    Ask,
    Deny,
    Indeterminate,
}

internal static class ToolAuthorizationEvaluation
{
    private static bool Equal(JsonNode? expected, AuthorizationFact actual)
    {
        if (!actual.Present)
            return false;
        if (expected is null || actual.Value is null)
            return expected is null && actual.Value is null;
        if (expected.GetValueKind() != actual.Value.GetValueKind())
            return false;
        if (ToolAuthorizationPolicy.Number(expected) is double number)
            return number == ToolAuthorizationPolicy.Number(actual.Value);
        return JsonNode.DeepEquals(expected, actual.Value);
    }

    internal static bool Scalar(JsonNode? matcher, AuthorizationFact actual)
    {
        if (matcher is JsonArray list)
            return list.Any(item => Equal(item, actual));
        if (matcher is JsonObject map)
        {
            if (map.ContainsKey("exists") && map["exists"]!.GetValue<bool>() != actual.Present)
                return false;
            if (map.ContainsKey("equals") && !Equal(map["equals"], actual))
                return false;
            if (map["oneOf"] is JsonArray values && !values.Any(item => Equal(item, actual)))
                return false;
            return true;
        }
        return Equal(matcher, actual);
    }

    private static bool Optional(JsonObject match, string key, AuthorizationFact actual) =>
        !match.ContainsKey(key) || Scalar(match[key], actual);

    internal static bool ToolMatches(JsonNode? matcher, string source, string name, string? server)
    {
        // Read old persisted selectors as the renamed builtin only. This is not a
        // dispatch alias, and MCP/Node tools with the same name retain their identities.
        bool Name(JsonNode? selector) =>
            Scalar(selector, AuthorizationFact.Of(name))
            || source == "builtin"
                && name == "view_session"
                && Scalar(selector, AuthorizationFact.Of("get_session_messages"));
        if (matcher is JsonObject map)
            return Optional(map, "source", AuthorizationFact.Of(source))
                && Optional(map, "server", AuthorizationFact.Of(server))
                && (!map.ContainsKey("name") || Name(map["name"]));
        return Name(matcher);
    }

    internal static bool Identity(
        JsonObject match,
        ToolAuthorizationRequest request,
        bool unknownNode = false,
        bool unknownNodeTargets = false,
        bool deny = false
    ) =>
        (
            !match.ContainsKey("agent")
            || request.Principal == "internal"
                && Scalar(match["agent"], AuthorizationFact.Of(request.Agent))
        )
        && Optional(match, "session", AuthorizationFact.Of(request.Session))
        && (
            !match.ContainsKey("sessionPattern")
            || Pattern(match["sessionPattern"]!, request.Session)
        )
        && (
            !match.ContainsKey("externalId")
            || request.Principal == "external"
                && Scalar(match["externalId"], AuthorizationFact.Of(request.ExternalId))
        )
        && (
            !match.ContainsKey("tool")
            || ToolMatches(match["tool"], request.Source, request.Name, request.Server)
        )
        && (unknownNode || Optional(match, "targetNode", AuthorizationFact.Of(request.TargetNode)))
        && (
            unknownNodeTargets
            || !match.ContainsKey("node")
            || NodeTargets(match["node"]!, request, deny)
        );

    private static bool Pattern(JsonNode pattern, string? actual)
    {
        if (actual is null)
            return false;
        var patterns = pattern is JsonArray list
            ? list.Select(SessionWait.Text)
            : new[] { SessionWait.Text(pattern) };
        return patterns.Any(item =>
        {
            var parts = item!.Split('*');
            if (parts.Length == 1)
                return actual == item;
            if (
                !actual.StartsWith(parts[0], StringComparison.Ordinal)
                || !actual.EndsWith(parts[^1], StringComparison.Ordinal)
            )
                return false;
            var offset = parts[0].Length;
            var end = actual.Length - parts[^1].Length;
            foreach (var part in parts[1..^1])
            {
                var index = actual.IndexOf(part, offset, StringComparison.Ordinal);
                if (index < 0 || index + part.Length > end)
                    return false;
                offset = index + part.Length;
            }
            return offset <= end;
        });
    }

    private static bool NodeTargets(JsonNode matcher, ToolAuthorizationRequest request, bool deny)
    {
        if (request.NodeTargets is not { Count: > 0 } targets)
            return false;
        bool Matches(string node)
        {
            if (matcher is not JsonObject map)
                return request.NodeForest is { } forest && forest.Contains(node)
                    ? forest.Chain(node).Any(ancestor => Pattern(matcher, ancestor))
                    : Pattern(matcher, node);
            if (map.ContainsKey("exact"))
                return Scalar(map["exact"], AuthorizationFact.Of(node));
            if (map.ContainsKey("current"))
                return request.Principal == "internal"
                    && request.CurrentNode is not null
                    && request.CurrentNode == node;
            var slash = node.IndexOf('/');
            var provider =
                slash > 0 ? node[..slash]
                : node == "master" ? "master"
                : "authenticated-remote";
            return Pattern(map["provider"]!, provider);
        }
        return deny ? targets.Any(Matches) : targets.All(Matches);
    }

    internal static AuthorizationFact Argument(JsonObject args, string path)
    {
        JsonNode? current = args;
        foreach (var part in path.Split('.'))
        {
            if (current is JsonObject map && map.TryGetPropertyValue(part, out var value))
                current = value;
            else if (current is JsonArray array && part == "length")
                current = JsonValue.Create(array.Count);
            else if (
                current is JsonArray sequence
                && int.TryParse(part, out var index)
                && index >= 0
                && index < sequence.Count
                && index.ToString(System.Globalization.CultureInfo.InvariantCulture) == part
            )
                current = sequence[index];
            else
                return new(false, null);
        }
        return new(true, current);
    }

    private static bool SessionMatch(JsonObject match, ToolAuthorizationRequest request)
    {
        var target = request.SessionTarget;
        if (request.Principal != "internal" || target is null)
            return false;
        if (
            match.ContainsKey("self") && target.Id != request.Session
            || match.ContainsKey("sameAgent") && target.Agent != request.Agent
        )
            return false;
        if (match.ContainsKey("relation"))
        {
            var relations = match["relation"] is JsonArray list
                ? list.Select(SessionWait.Text)
                : new[] { SessionWait.Text(match["relation"]) };
            if (
                !relations.Any(relation =>
                    relation == "parent"
                        ? target.Id == request.SourceParent
                        : target.Parent == request.Session
                )
            )
                return false;
        }
        return true;
    }

    private static bool ArgumentMatches(
        string key,
        JsonNode? matcher,
        ToolAuthorizationRequest request
    ) =>
        matcher is JsonObject wrapper && wrapper["session"] is JsonObject session
            ? SessionMatch(session, request)
        : matcher is JsonObject task && task.ContainsKey("task")
            ? request.Principal == "internal"
                && request.TaskOwnerSession is not null
                && request.TaskOwnerSession == request.Session
        : matcher is JsonObject agent && agent["agent"] is JsonObject comparison
            ? request.Principal == "internal"
                && request.Agent is not null
                && SessionWait.Text(Argument(request.Args, key).Value) is { Length: > 0 } target
                && (target == request.Agent) == comparison["sameAgent"]!.GetValue<bool>()
        : Scalar(matcher, Argument(request.Args, key));

    private static bool Arguments(JsonObject? match, ToolAuthorizationRequest request) =>
        match is null || match.All(pair => ArgumentMatches(pair.Key, pair.Value, request));

    // Timer registration knows the creation Agent, not future names or settings. Preserve
    // every possible first-match outcome; a mixed result is not an authorization grant.
    internal static CreationTargetDecision EvaluateCreationTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        if (
            request.Source != "builtin"
            || request.Name != "create_session"
            || SessionWait.Text(request.Args["agentName"]) is not { Length: > 0 }
        )
            throw new InvalidDataException("Creation target authorization requires an Agent.");
        var allow = false;
        var ask = false;
        var deny = false;
        CreationTargetDecision Outcome() =>
            allow && (ask || deny) ? CreationTargetDecision.Indeterminate
            : allow ? CreationTargetDecision.Allow
            : deny ? CreationTargetDecision.Deny
            : CreationTargetDecision.Ask;
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (
                !rule["enabled"]!.GetValue<bool>()
                || !Identity(match, request, deny: Restrictive(rule))
                || !Paths(match["path"] as JsonObject, request)
            )
                continue;
            var unknown = false;
            var matches = true;
            foreach (var pair in match["args"] as JsonObject ?? new())
            {
                if (
                    pair.Key == "agentName"
                    || pair.Key.StartsWith("agentName.", StringComparison.Ordinal)
                )
                    matches &= ArgumentMatches(pair.Key, pair.Value, request);
                else
                    unknown = true;
            }
            if (!matches)
                continue;
            var effect = AuthorizationDecision.Parse(SessionWait.Text(rule["action"]));
            allow |= effect == ToolAuthorizationEffect.Allow;
            ask |= effect == ToolAuthorizationEffect.Ask;
            deny |= effect == ToolAuthorizationEffect.Deny;
            if (!unknown)
                return Outcome();
        }
        var fallback = Default(policy, request);
        allow |= fallback == ToolAuthorizationEffect.Allow;
        ask |= fallback == ToolAuthorizationEffect.Ask;
        deny |= fallback == ToolAuthorizationEffect.Deny;
        return Outcome();
    }

    // Deny and ask rules restrict; unresolved multi-target facts match them conservatively.
    private static bool Restrictive(JsonObject rule) =>
        SessionWait.Text(rule["action"]) is "deny" or "ask";

    // External principals never fall through to a grant and cannot be asked.
    private static ToolAuthorizationEffect Default(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        request.Principal == "internal"
            ? AuthorizationDecision.Parse(SessionWait.Text(policy.Value["defaultAction"]))
            : ToolAuthorizationEffect.Deny;

    private static ToolAuthorizationEffect RuleEffect(
        JsonObject rule,
        ToolAuthorizationRequest request
    ) =>
        AuthorizationDecision.Parse(SessionWait.Text(rule["action"])) is var effect
        && (effect != ToolAuthorizationEffect.Ask || request.Principal == "internal")
            ? effect
            : ToolAuthorizationEffect.Deny;

    internal static bool Within(string? path, string root)
    {
        if (path is null)
            return false;
        var normalized = Path.GetFullPath(path);
        return normalized == root
            || normalized.StartsWith(
                Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar,
                StringComparison.Ordinal
            );
    }

    private static string? Base(string text, ToolAuthorizationRequest request)
    {
        if (
            request.Principal == "external"
            && (
                text.Contains("${agent.dir}", StringComparison.Ordinal)
                || text.Contains("${agent.memoryDir}", StringComparison.Ordinal)
            )
        )
            return null;
        if (request.Principal == "internal")
            text = text.Replace("${agent.dir}", request.AgentDirectory!, StringComparison.Ordinal)
                .Replace("${agent.memoryDir}", request.MemoryDirectory!, StringComparison.Ordinal);
        return AuthorizationPaths.CanonicalPotential(
            text.Replace("${workspace}", request.Workspace, StringComparison.Ordinal)
        );
    }

    private static bool Paths(JsonObject? match, ToolAuthorizationRequest request)
    {
        if (match is null)
            return true;
        var names =
            match["arg"] is JsonArray list ? list.Select(SessionWait.Text).ToArray()
            : SessionWait.Text(match["arg"]) is string name ? [name]
            : null;
        var paths = names is null
            ? request.Paths
            : request
                .Paths.Where(path => names.Contains(path.Arg, StringComparer.Ordinal))
                .ToArray();
        if (paths.Count == 0)
            return false;
        if (SessionWait.Text(match["allWithin"]) is string all)
        {
            var root = Base(all, request);
            if (
                root is null
                || !paths.All(path => path.Node == "master" && Within(path.Resolved, root))
            )
                return false;
        }
        if (SessionWait.Text(match["anyNotWithin"]) is string any)
        {
            var root = Base(any, request);
            if (
                root is null
                || !paths.Any(path => path.Node != "master" || !Within(path.Resolved, root))
            )
                return false;
        }
        return true;
    }

    private static void ValidateNodeAncestry(ToolAuthorizationRequest request)
    {
        if (request.NodeForest is not { } forest || request.NodeTargets is not { } targets)
            return;
        foreach (var node in targets)
            if (forest.Contains(node))
                _ = forest.Chain(node);
    }

    internal static AuthorizationDecision Evaluate(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    )
    {
        ValidateNodeAncestry(request);
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (
                rule["enabled"]!.GetValue<bool>()
                && Identity(match, request, deny: Restrictive(rule))
                && Arguments(match["args"] as JsonObject, request)
                && Paths(match["path"] as JsonObject, request)
            )
                return new(RuleEffect(rule, request), rule);
        }
        return new(Default(policy, request), null);
    }

    internal static bool Visible(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request,
        bool unknownNode = false,
        bool unknownNodeTargets = false
    )
    {
        if (!unknownNodeTargets)
            ValidateNodeAncestry(request);
        foreach (var rule in policy.Value["rules"]!.AsArray().OfType<JsonObject>())
        {
            var match = rule["match"]!.AsObject();
            if (
                !rule["enabled"]!.GetValue<bool>()
                || !Identity(match, request, unknownNode, unknownNodeTargets, Restrictive(rule))
            )
                continue;
            var conditional =
                match.ContainsKey("path")
                || match["args"] is JsonObject args && args.Count > 0
                || unknownNode && match.ContainsKey("targetNode")
                || unknownNodeTargets && match.ContainsKey("node");
            // A call that can proceed after approval remains discoverable.
            var possible = RuleEffect(rule, request) != ToolAuthorizationEffect.Deny;
            if (!conditional)
                return possible;
            if (possible)
                return true;
        }
        return Default(policy, request) != ToolAuthorizationEffect.Deny;
    }

    internal static bool NeedsTaskTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        request.Source == "builtin"
        && request.Name == "task"
        && policy.Value["rules"]!
            .AsArray()
            .OfType<JsonObject>()
            .Any(rule =>
                rule["enabled"]!.GetValue<bool>()
                && Identity(rule["match"]!.AsObject(), request, deny: Restrictive(rule))
                && (rule["match"]?["args"] as JsonObject ?? new()).Any(pair =>
                    pair.Value is JsonObject map && map.ContainsKey("task")
                )
            );

    internal static bool NeedsTarget(
        ToolAuthorizationPolicy policy,
        ToolAuthorizationRequest request
    ) =>
        policy.Value["rules"]!
            .AsArray()
            .OfType<JsonObject>()
            .Any(rule =>
                rule["enabled"]!.GetValue<bool>()
                && Identity(rule["match"]!.AsObject(), request, deny: Restrictive(rule))
                && (rule["match"]?["args"] as JsonObject ?? new()).Any(pair =>
                    pair.Value is JsonObject map && map.ContainsKey("session")
                )
            );
}

internal static class AuthorizationPaths
{
    internal static string CanonicalPotential(string path)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string Resolve(string candidate)
        {
            var full = Path.GetFullPath(candidate);
            var current = Path.GetPathRoot(full)!;
            var segments = full[current.Length..]
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
            for (var index = 0; index < segments.Length; index++)
            {
                current = Path.Combine(current, segments[index]);
                var info = new FileInfo(current);
                var link = info.LinkTarget;
                if (link is not null)
                {
                    if (!seen.Add(current))
                        throw new IOException("Symlink cycle in authorization path.");
                    var target = Path.IsPathRooted(link)
                        ? link
                        : Path.Combine(Path.GetDirectoryName(current)!, link);
                    try
                    {
                        current = Resolve(target);
                    }
                    finally
                    {
                        seen.Remove(info.FullName);
                    }
                }
                else
                {
                    try
                    {
                        _ = File.GetAttributes(current);
                    }
                    catch (Exception error)
                        when (error is FileNotFoundException or DirectoryNotFoundException)
                    {
                        return Path.Combine(
                            new[] { current }.Concat(segments[(index + 1)..]).ToArray()
                        );
                    }
                }
            }
            return Path.TrimEndingDirectorySeparator(current);
        }
        return Resolve(path);
    }
}

internal static class ToolAuthorizationNodeEffects
{
    private static bool Valid(string? id) =>
        id is not null
        && System.Text.RegularExpressions.Regex.IsMatch(
            id,
            @"^(?:[A-Za-z0-9._:-]{1,128}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$",
            System.Text.RegularExpressions.RegexOptions.CultureInvariant
        );

    internal static IReadOnlyList<string>? Resolve(
        string source,
        string name,
        string? targetNode,
        JsonObject args
    )
    {
        if (source == "node" || source == "builtin" && name is "send_file" or "image_write_to_file")
            return Valid(targetNode) ? [targetNode!] : null;
        if (source != "builtin")
            return null;
        if (name == "artifact" && ToolRegistry.ArtifactFileSource(args))
            return Valid(targetNode) ? [targetNode!] : null;
        if (name == "copy_between_nodes")
        {
            var endpoints = new[]
            {
                SessionWait.Text(args["sourceNode"])?.Trim(),
                SessionWait.Text(args["targetNode"])?.Trim(),
            };
            return endpoints.All(Valid) ? endpoints.Select(value => value!).ToArray() : null;
        }
        if (
            name == "node_create_auth_token"
            && SessionWait.Text(args["parentNode"]) is string parent
            && Valid(parent)
        )
            return [parent];
        if (
            name == "node_remove"
            && SessionWait.Text(args["nodeId"])?.Trim() is string removed
            && Valid(removed)
        )
            return [removed];
        if (
            name == "node"
            && SessionWait.Text(args["action"])?.Trim().ToLowerInvariant()
                is "select"
                    or "inspect"
                    or "destroy"
            && !args.ContainsKey("providerId")
            && SessionWait.Text(args["nodeId"])?.Trim() is string node
            && Valid(node)
        )
            return [node];
        return null;
    }
}
