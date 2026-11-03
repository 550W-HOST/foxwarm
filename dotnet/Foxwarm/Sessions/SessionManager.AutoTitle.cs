using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private static readonly TimeSpan AutoTitleTimeout = TimeSpan.FromMinutes(2);

    private static void AutoTitleTurnStarting(SessionOwner owner)
    {
        if (owner.AutoTitle.Settled)
            return;
        owner.AutoTitle.TurnStarting(owner.Entry.WithState(state => state.NextMessageSeq));
    }

    // Called from the foreground turn's completion callback. It decides synchronously
    // from the committed snapshot and detaches the request; failures stay silent.
    private void StartAutoTitle(SessionOwner owner)
    {
        var state = owner.AutoTitle;
        // Off when unconfigured. Not settling keeps a still-unanswered Session eligible
        // if the setting is enabled live before its first reply.
        if (state.Settled || models.ConfigurationOwner?.SessionAutoTitleEnabled != true)
            return;
        try
        {
            if (SessionCatalog.Text(Catalog.Get(owner.Id)?["displayName"]) is { Length: > 0 })
            {
                state.Settle();
                return;
            }
            var snapshot = owner.Entry.Snapshot();
            var selection = SessionAutoTitle.Select(snapshot.History, state.TurnStartSeq);
            if (selection.Outcome == SessionAutoTitle.Outcome.Pending)
                return;
            if (!state.Settle() || selection.Outcome != SessionAutoTitle.Outcome.Ready)
                return;
            if (!Accepting || IsDeletionClaimed(owner.Id) || owner.Entry.Retired)
                return;
            var lifetime = TrackCreation();
            using (ExecutionContext.SuppressFlow())
                state.Pending = Task.Run(() =>
                    RunAutoTitleAsync(snapshot, selection.Exchange!, lifetime)
                );
        }
        catch (Exception error)
        {
            Trace.TraceWarning("Automatic Session title was skipped: {0}", error.Message);
        }
    }

    private async Task RunAutoTitleAsync(
        SessionSnapshot snapshot,
        SessionAutoTitle.Exchange exchange,
        IDisposable lifetime
    )
    {
        using var _ = lifetime;
        ChatResult? result = null;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(
                admissionStop.Token
            );
            timeout.CancelAfter(AutoTitleTimeout);
            var catalog = models.Capture();
            var selected = catalog.Select(snapshot.AuthorityEnvelope);
            var requests = new ModelRequestOwner(
                http,
                clientOptions,
                modelRouting,
                websockets: websockets,
                journal: Journal,
                diagnostics: diagnostics
            );
            var captured = requests.Capture(
                catalog,
                selected.RawModel ?? catalog.DefaultKey,
                SessionAutoTitle.Effort
            );
            result = await requests.RequestAsync(
                snapshot.Id,
                captured,
                SessionAutoTitle.CacheLineage,
                Guid.NewGuid().ToString(),
                [SessionAutoTitle.RequestMessage(exchange)],
                (_, _) => Task.FromResult(SessionAutoTitle.Instructions),
                null,
                null,
                null,
                error => Trace.TraceWarning("Automatic Session title warning: {0}", error.Message),
                timeout.Token,
                ModelRequestScope.LowLevel,
                () => new JsonArray(),
                journalPurpose: SessionAutoTitle.JournalPurpose,
                maxAttempts: 1
            );
            var title = SessionAutoTitle.Normalize(
                SessionAutoTitle.AssistantText(result.AssistantMessage)
            );
            if (title is null)
                return;
            // Resolve after the request: a move keeps an alias, deletion leaves nothing to label.
            if (SessionCatalog.Text(Catalog.Resolve(snapshot.Id)["sessionId"]) is not { } current)
                return;
            RenameIfUnnamed(current, title);
        }
        catch (Exception error)
        {
            Trace.TraceWarning("Automatic Session title failed: {0}", error.Message);
        }
        finally
        {
            // A detached result is not a canonical history continuation.
            result?.FinalizeHistory(null);
        }
    }
}
