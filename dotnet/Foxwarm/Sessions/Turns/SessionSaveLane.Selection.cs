using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    /// <summary>
    /// Adopts the attempt's effective selection. With <paramref name="messageEffort"/>, an
    /// effort that differs from the one in force is also recorded once, at this position.
    /// </summary>
    internal async Task<bool> AdoptEffectiveSelectionAsync(
        EffectiveRequestSelection selection,
        bool failover,
        bool messageEffort = false
    )
    {
        if (
            entry.WithState(state =>
                EffectiveRequestSelection.Read(state.Meta["lastEffectiveRequest"]) == selection
                && (
                    !messageEffort
                    || AnthropicMessageEffort.InForce(state.History, selection.ModelId)
                        is not { } inForce
                    || inForce == selection.Effort
                )
            )
        )
            return false;
        var appended = false;
        IReadOnlyList<JsonObject> rows = [];
        try
        {
            await CommitCanonicalAppendWithResultAsync(
                    state =>
                    {
                        var previous = EffectiveRequestSelection.Read(
                            state.Meta["lastEffectiveRequest"]
                        );
                        var notice = selection.Notice(previous, failover);
                        var change = messageEffort
                            ? AnthropicMessageEffort.Change(state.History, selection, previous)
                            : null;
                        JsonObject[] additions =
                        [
                            .. notice is null ? [] : new[] { notice },
                            .. change is null ? [] : new[] { change.ToRow() },
                        ];
                        appended = additions.Length > 0;
                        var operation = LocalSessionTurnHost.PrepareCanonicalAppend(
                            state,
                            additions,
                            [],
                            false,
                            false,
                            () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                        );
                        var meta = (JsonObject)operation.StagedSnapshot.Meta.DeepClone();
                        meta["lastEffectiveRequest"] = selection.ToJson();
                        var publish = operation.Publish;
                        rows = operation.AppendedMessages;
                        return operation with
                        {
                            StagedSnapshot = operation.StagedSnapshot with { Meta = meta },
                            Publish = live =>
                            {
                                publish(live);
                                live.Meta["lastEffectiveRequest"] = selection.ToJson();
                            },
                        };
                    },
                    notifyMessages: false
                )
                .ConfigureAwait(false);
        }
        catch (AuthorityCommittedException)
        {
            entry.InvokeHistoryAppended(rows);
            entry.InvokeCommitted(entry.Snapshot());
            throw;
        }
        entry.InvokeHistoryAppended(rows);
        entry.InvokeCommitted(entry.Snapshot());
        return appended;
    }
}
