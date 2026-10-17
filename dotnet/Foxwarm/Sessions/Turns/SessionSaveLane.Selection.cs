using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

public sealed partial class SessionSaveLane
{
    internal async Task<bool> AdoptEffectiveSelectionAsync(
        EffectiveRequestSelection selection,
        bool failover
    )
    {
        if (
            entry.WithState(state =>
                EffectiveRequestSelection.Read(state.Meta["lastEffectiveRequest"])
            ) == selection
        )
            return false;
        var appended = false;
        try
        {
            await CommitCanonicalAppendAsync(state =>
                {
                    var notice = selection.Notice(
                        EffectiveRequestSelection.Read(state.Meta["lastEffectiveRequest"]),
                        failover
                    );
                    appended = notice is not null;
                    var operation = LocalSessionTurnHost.PrepareCanonicalAppend(
                        state,
                        notice is null ? [] : [notice],
                        [],
                        false,
                        false,
                        () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    );
                    var meta = (JsonObject)operation.StagedSnapshot.Meta.DeepClone();
                    meta["lastEffectiveRequest"] = selection.ToJson();
                    var publish = operation.Publish;
                    return operation with
                    {
                        StagedSnapshot = operation.StagedSnapshot with { Meta = meta },
                        Publish = live =>
                        {
                            publish(live);
                            live.Meta["lastEffectiveRequest"] = selection.ToJson();
                        },
                    };
                })
                .ConfigureAwait(false);
        }
        catch (AuthorityCommittedException)
        {
            entry.InvokeCommitted(entry.Snapshot());
            throw;
        }
        entry.InvokeCommitted(entry.Snapshot());
        return appended;
    }
}
