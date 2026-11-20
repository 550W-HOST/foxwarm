using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Approval helpers shared by the staged-approval tests of several fixtures.
internal static class ApprovalStagingSupport
{
    internal static readonly JsonObject Administrator = new() { ["kind"] = "administrator" };

    internal static JsonObject[] Records(SessionOwner owner) =>
        owner.Entry.WithState(state =>
            SessionApprovals.Records(state.Meta).Select(record => (JsonObject)record.DeepClone()).ToArray()
        );

    // The next pending approval whose ID is not among those already seen.
    internal static async Task<JsonObject> PendingAsync(
        SessionOwner owner,
        params string[] seen
    )
    {
        for (var attempt = 0; attempt < 800; attempt++)
        {
            var pending = owner.Entry.WithState(state =>
                SessionApprovals
                    .Pending(state.Meta)
                    .FirstOrDefault(record =>
                        !seen.Contains(SessionWait.Text(record["id"]), StringComparer.Ordinal)
                    )
                    ?.DeepClone() as JsonObject
            );
            if (pending is not null)
                return pending;
            await Task.Delay(25);
        }
        throw new TimeoutException("No pending approval appeared.");
    }

    internal static string Id(JsonObject record) => record["id"]!.GetValue<string>();

    internal static Task Approve(SessionManager manager, SessionOwner owner, JsonObject record) =>
        manager.DecideToolApprovalAsync(owner, Id(record), true, null, Administrator);

    internal static string[] Approvers(JsonObject record) =>
        record["approvers"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray();

    internal static string[] CheckIds(JsonObject record) =>
        (record["checks"] as JsonArray ?? [])
            .Select(item => item!["id"]!.GetValue<string>())
            .ToArray();

    // A scope whose grant lists exactly these fingerprints, as a call approval would.
    internal static ToolApprovalScope Granted(
        SessionOwner owner,
        ResolvedTool? primary,
        params string[] fingerprints
    )
    {
        var scope = new ToolApprovalScope(owner) { Primary = primary };
        scope.Add(new("ap-fixture", fingerprints.ToHashSet(StringComparer.Ordinal), null));
        return scope;
    }

    internal static string? ErrorType(JsonNode? result) =>
        result.FailureIdentity();
}
