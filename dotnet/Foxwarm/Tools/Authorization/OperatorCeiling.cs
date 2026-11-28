using System.Text;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>A stored ceiling document and where it came from (<c>tenant</c> or <c>profile:&lt;name&gt;</c>).</summary>
internal sealed record OperatorCeilingDocument(string Source, string Text);

/// <summary>
/// Reads the ceiling document that applies to this runtime's tenant: null when none applies.
/// A read that fails throws; the authority then fails closed as for the tenant policy.
/// </summary>
internal interface IOperatorCeilingSource
{
    OperatorCeilingDocument? Read();
    Task<OperatorCeilingDocument?> ReadAsync(CancellationToken token) => Task.FromResult(Read());
}

/// <summary>
/// The operator ceiling (P2 plan §6.2, E12): an operator-owned layer of tool authorization in
/// version-1 rule syntax, evaluated before the tenant's global policy. Like every layer it must
/// pass, deny over ask over allow. Its rules may only deny or ask, and anything it doesn't match
/// passes, for internal and external principals alike: the ceiling only restricts what the
/// tenant's own layers decide. It is policy, not isolation; capability absence is the boundary.
/// File mode has no ceiling.
/// </summary>
internal static class OperatorCeiling
{
    /// <summary>
    /// The ceiling's layer name in assessments, beside null (the global policy) and Agent names.
    /// Agent names never contain <c>:</c>, so it can't collide with one.
    /// </summary>
    internal const string Layer = ":ceiling";

    /// <summary>The reason a ceiling deny gives.</summary>
    internal const string DenialReason = "Blocked by a restriction of this deployment's operator.";

    /// <summary>
    /// Parses and validates a ceiling document: a version-1 policy without allow rules and
    /// without a default other than the implicit pass.
    /// </summary>
    internal static ToolAuthorizationPolicy Parse(string text)
    {
        // Checked as written: normalization fills an omitted default with allow, so an explicit
        // `defaultAction: allow` would otherwise look like the implicit pass.
        var policy = ToolAuthorizationYaml.Parse(
            Encoding.UTF8.GetBytes(text),
            document =>
            {
                if (document.ContainsKey("defaultAction"))
                    throw new InvalidDataException(
                        "An operator ceiling has no defaultAction: anything its rules don't match passes."
                    );
            }
        );
        foreach (var rule in (policy.Value["rules"] as System.Text.Json.Nodes.JsonArray ?? []).OfType<System.Text.Json.Nodes.JsonObject>())
        {
            var action = SessionWait.Text(rule["action"]);
            if (action == "allow")
                throw new InvalidDataException(
                    $"Operator ceiling rule `{SessionWait.Text(rule["id"])}` allows; a ceiling rule may only deny or ask."
                );
            // What a tenant is shown for a ceiling deny, wherever a rule's reason appears
            // (the denial, explain); the operator's own reason stays in its document.
            if (action == "deny")
                rule["reason"] = DenialReason;
        }
        return policy with { PassesByDefault = true };
    }

    /// <summary>The label of an assessment layer in explain and approval output.</summary>
    internal static string Label(string? layer) =>
        layer is null ? "global"
        : layer == Layer ? "ceiling"
        : "agent:" + layer;
}
