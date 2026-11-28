using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;

namespace Foxwarm.Hosted.Operator;

internal sealed partial class OperatorStore
{
    internal async Task<JsonObject> RequestTenantPlacementAsync(
        string slug,
        int id,
        string boot,
        long epoch,
        PlacementAction action,
        CancellationToken token
    )
    {
        var requests = new ReplicaPlacementRequests(database, LeaseTimings.Default);
        var result = await requests.RequestTenantAsync(slug, id, boot, epoch, action, token);
        switch (result)
        {
            case PlacementRequestResult.Stale:
                throw new OperatorProblem(
                    409,
                    "This tenant no longer holds the selected lease. Refresh placement before trying again."
                );
            case PlacementRequestResult.Conflict:
                throw new OperatorProblem(
                    409,
                    "Another placement action is already pending for this tenant."
                );
            case PlacementRequestResult.NoTarget:
                throw new OperatorProblem(
                    409,
                    "No other eligible replica can take this tenant. It will stay on its current replica."
                );
            case PlacementRequestResult.Accepted:
            case PlacementRequestResult.AlreadyRequested:
                return new JsonObject
                {
                    ["slug"] = slug,
                    ["tenantId"] = id,
                    ["owner"] = boot,
                    ["epoch"] = epoch,
                    ["requestedAction"] = action == PlacementAction.Move ? "move" : "release",
                };
            default:
                throw new InvalidOperationException("Unknown placement request result.");
        }
    }

    internal async Task<JsonObject> RequestReplicaDrainAsync(string boot, CancellationToken token)
    {
        var requests = new ReplicaPlacementRequests(database, LeaseTimings.Default);
        if (!await requests.RequestReplicaDrainAsync(boot, token))
            throw new OperatorProblem(
                404,
                "That replica boot is no longer available. Refresh placement before trying again."
            );
        return new JsonObject { ["id"] = boot, ["draining"] = true };
    }
}
