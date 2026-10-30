using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

public sealed partial class LocalSessionTurnHost
{
    internal SessionToolExecutor RuntimeTools =>
        tools as SessionToolExecutor
        ?? throw new InvalidOperationException("Runtime requires the attributed Session executor.");

    // One MCP request is one supported tool exchange, not an invented model-wide batch.
    // This reuses the normal attribution, image, receipt and complete-row settlement owners.
    internal async Task<JsonObject> ExecuteRuntimeToolAsync(
        JsonObject call,
        CancellationToken token
    )
    {
        if ((call["args"] as JsonObject)?.ContainsKey("__cancelAllToolsThisTurn") == true)
            throw new InvalidDataException(
                "Response-wide batch controls are not supported by the Claude Code runtime."
            );
        var model = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(new JsonObject { ["functionCall"] = call.DeepClone() }),
            ["__meta"] = new JsonObject { ["runtime"] = ClaudeRuntimeState.Kind },
        };
        var assistant = await AppendHistoryMessageStrictAsync(model).ConfigureAwait(false);
        RuntimeTools.BeginBatch(assistant[^1]);
        try
        {
            var parts = await ExecuteToolBatchAsync(
                    ToolCallControls.Plan([call], RuntimeTools.HandoffConfirmationEnabled),
                    token
                )
                .ConfigureAwait(false);
            var parent = ParentSessionId();
            if (
                RuntimeTools
                    .ConsumeReceipts()
                    .Any(receipt =>
                        receipt.AttachedSessionId == entry.Snapshot().Id
                            && receipt.CompletedTaskId is not null
                        || parent is not null && receipt.SuccessfulSendTarget == parent
                    )
            )
                await entry.SaveLane.ResolveChildHandoffAsync().ConfigureAwait(false);
            var row = new JsonObject { ["role"] = "tool", ["parts"] = parts };
            var committed = await AppendHistoryMessageStrictAsync(row).ConfigureAwait(false);
            await RuntimeTools
                .CompleteBatchAsync(committed[^1], entry.WithState(state => state.Stopping))
                .ConfigureAwait(false);
            var projected = store is PersistentSessionAuthorityStore persistent
                ? await persistent
                    .Images.HydrateAsync(
                        [committed[^1]],
                        "anthropic",
                        token: CancellationToken.None
                    )
                    .ConfigureAwait(false)
                : [committed[^1]];
            return RuntimeMcpService.ToolResult(projected[0]);
        }
        finally
        {
            await RuntimeTools.EndBatchAsync().ConfigureAwait(false);
        }
    }
}
