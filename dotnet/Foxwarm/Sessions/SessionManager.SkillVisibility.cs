using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Skill listings are a presentation projection of the `skill` and `run_skill` rules: a skill is
// listed when loading it might be allowed and shows its run entry when running it might be.
// Load and run are still authorized at dispatch.
internal sealed partial class SessionManager
{
    // The `skill load` call the catalog tells the model to make; agentName and path are absent.
    private static readonly IReadOnlySet<string> SkillLoadKnown = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "action",
        "skillName",
        "agentName",
        "path",
    };

    // `skill run <name>`: mode, timeoutSecs and args stay unknown.
    private static readonly IReadOnlySet<string> SkillRunKnown = new HashSet<string>(
        StringComparer.Ordinal
    )
    {
        "skillName",
        "agentName",
        "script",
    };

    // The catalog filter of one snapshot build, from one visibility context. Null lists every
    // skill unchanged: the global policy is unavailable (user decision 2026-11-25, U6), and
    // every tool call fails closed until it is readable again.
    private Func<SkillInfo, SkillAccess>? CatalogSkillAccess(string agent, string session)
    {
        // `skill` and `run_skill` have no Node facts, so the current Node only fills the context;
        // a Session still being created is not hosted yet.
        var current = sessions.TryGetValue(session, out var owner) ? CurrentNode(owner) : "master";
        var context = new ToolVisibilityContext(this, agent, session, current, externalRuntime: false);
        if (context.Layers is not null)
            try
            {
                _ = context.Policies;
            }
            catch (ToolAuthorizationUnavailableException error)
            {
                Console.Error.WriteLine(
                    $"Skill catalog for Session '{session}' is not filtered by tool rules: {error.Message}"
                );
                return null;
            }
        return SkillAccessFor(context, agentName: null);
    }

    // agentName is the raw argument of the listing call, so each probe is the call the caller
    // would make for that skill.
    internal Func<SkillInfo, SkillAccess> SkillAccessFor(
        ToolVisibilityContext context,
        string? agentName
    ) =>
        skill =>
        {
            var load = new JsonObject { ["action"] = "load", ["skillName"] = skill.Name };
            if (agentName is not null)
                load["agentName"] = agentName;
            if (!SkillToolVisible(context, "skill", load, SkillLoadKnown))
                return SkillAccess.Hidden;
            if (skill.Run is null)
                return SkillAccess.Load;
            var run = new JsonObject { ["skillName"] = skill.Name };
            if (agentName is not null)
                run["agentName"] = agentName;
            return SkillToolVisible(context, "run_skill", run, SkillRunKnown)
                ? SkillAccess.Run
                : SkillAccess.Load;
        };

    private bool SkillToolVisible(
        ToolVisibilityContext context,
        string name,
        JsonObject args,
        IReadOnlySet<string> known
    ) =>
        VisibleRequest(
            context,
            "builtin",
            name,
            null,
            args,
            "master",
            ToolAuthorizationNodeEffects.Resolve("builtin", name, "master", args),
            unknownNode: false,
            unknownNodeTargets: false,
            known
        );
}
