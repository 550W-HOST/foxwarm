using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Upgrade warnings for automation and text written for the tool set before ctl (user decision
// 2026-11-16): scripts calling search_tools, rule layers naming the removed front ends or
// self-scoped builtins, and Agent memory and skills naming search_tools or call_tool. They are
// warnings only, never blockers. Each names the file or record so the owner can act; script
// code, rule bodies, memory text and configuration values are never printed.
internal static partial class SessionUpgradeInspection
{
    private const string Category = "tool names";
    private const long TextLimit = 1024 * 1024;
    private const int FileLimit = 4096;
    private static readonly Regex RemovedTools = new(@"\b(search_tools|call_tool)\b");
    private static readonly Regex SearchTools = new(@"\bsearch_tools\b");

    private static void InspectToolNames(
        HostPaths paths,
        AgentCatalog? agents,
        AccessConfiguration? access,
        List<SessionUpgradeIssue> issues
    )
    {
        void Warn(string detail) => issues.Add(new(false, Category, detail));
        void Check(string what, Action action)
        {
            try
            {
                action();
            }
            catch (Exception error) when (error is not OutOfMemoryException)
            {
                Warn($"{what} could not be checked: {MainLog.SafeFailure(error)}");
            }
        }

        Check("Timers", () => InspectTimers(paths, Warn));
        if (access is not null)
            Check("Webhook scripts", () => InspectWebhooks(access, Warn));
        Check(
            "The tool authorization policy",
            () =>
            {
                var path = Path.Combine(paths.DataRoot, "state", "tool-authorization.yaml");
                if (!File.Exists(path))
                    return;
                foreach (var warning in ToolAuthorizationYaml.Parse(File.ReadAllBytes(path)).Warnings)
                    Warn("state/tool-authorization.yaml: " + warning);
            }
        );
        if (agents is not null)
            Check(
                "Agent rules",
                () =>
                {
                    foreach (var (agent, row) in agents.MetadataSnapshot())
                        if (row is JsonObject value && value["rules"] is JsonArray rules)
                            foreach (var warning in AgentRulePolicy.Parse(rules).Warnings)
                                Warn($"rules of Agent {JsonData.Serialize(agent)}: {warning}");
                }
            );
        Check("Agent memory and skills", () => InspectAgentText(paths, Warn));
    }

    private static void InspectTimers(HostPaths paths, Action<string> warn)
    {
        var path = Path.Combine(paths.DataRoot, "state", "timers.json");
        if (!File.Exists(path))
            return;
        var timers = JsonNode.Parse(File.ReadAllText(path))?["timers"] as JsonArray ?? [];
        foreach (var timer in timers.OfType<JsonObject>())
            if (ScriptCallsSearchTools(timer["script"] as JsonObject) is { } where)
                warn(
                    $"timer {JsonData.Serialize(SessionWait.Text(timer["id"]))} of Session {JsonData.Serialize(SessionWait.Text(timer["sessionId"]))}: its {where} calls search_tools, which no longer exists; use ctl('tool search <words>')."
                );
    }

    private static void InspectWebhooks(AccessConfiguration access, Action<string> warn)
    {
        foreach (var (identity, value) in access.Snapshot.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            if (ScriptCallsSearchTools(value.Webhook?.Script) is { } where)
                warn(
                    $"webhook of access identity {JsonData.Serialize(identity)}: its {where} calls search_tools, which no longer exists; use ctl('tool search <words>')."
                );
    }

    // "script" for inline code, "script file <path>" for a readable file-backed script on
    // master, else null. File-backed scripts on other Nodes are not reachable here.
    private static string? ScriptCallsSearchTools(JsonObject? script)
    {
        if (script is null)
            return null;
        if (SessionWait.Text(script["code"]) is { } code)
            return SearchTools.IsMatch(code) ? "script" : null;
        if (
            SessionWait.Text(script["filePath"]) is not { } file
            || !Path.IsPathFullyQualified(file)
            || SessionWait.Text(script["node"]) is { } node && node is not ("master" or "current")
        )
            return null;
        var info = new FileInfo(file);
        return info.Exists && info.Length <= TextLimit && SearchTools.IsMatch(File.ReadAllText(file))
            ? "script file " + JsonData.Serialize(file)
            : null;
    }

    private static void InspectAgentText(HostPaths paths, Action<string> warn)
    {
        if (!Directory.Exists(paths.AgentsRoot))
            return;
        var checkedFiles = 0;
        foreach (var agent in Directory.EnumerateDirectories(paths.AgentsRoot).Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(agent);
            if (name.StartsWith('.'))
                continue;
            foreach (var area in new[] { "memory", "skills" })
            {
                var root = Path.Combine(agent, area);
                if (!Directory.Exists(root))
                    continue;
                var files = Directory
                    .EnumerateFiles(
                        root,
                        "*.md",
                        new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint }
                    )
                    .Order(StringComparer.Ordinal);
                foreach (var file in files)
                {
                    if (++checkedFiles > FileLimit)
                    {
                        warn($"Stopped after {FileLimit} memory and skill files; check the rest by hand.");
                        return;
                    }
                    var info = new FileInfo(file);
                    if (info.Length > TextLimit)
                        continue;
                    var found = RemovedTools
                        .Matches(File.ReadAllText(file, Encoding.UTF8))
                        .Select(match => match.Value)
                        .Distinct(StringComparer.Ordinal)
                        .Order(StringComparer.Ordinal)
                        .ToArray();
                    if (found.Length > 0)
                        warn(
                            $"Agent file {JsonData.Serialize(Path.GetRelativePath(paths.AgentsRoot, file).Replace('\\', '/'))} mentions {string.Join(" and ", found)}; if it tells agents to use {(found.Length == 1 ? "it" : "them")}, rewrite it for ctl."
                        );
                }
            }
        }
    }
}
