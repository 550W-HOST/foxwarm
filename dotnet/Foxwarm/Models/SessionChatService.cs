using System.Text.Json.Nodes;
using Foxwarm.Sessions;
namespace Foxwarm.Models;

internal sealed class SessionChatService(
    ModelRequestOwner requests, ResponsesClientOptions baseOptions, SessionOwner hosted, HostModels models, AgentMemory memory,
    Action<string, ResponsesStreamProgress> progress) : IChatService
{
    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var selectedSnapshot = hosted.Entry.Snapshot(); var catalog = models.Capture(); var selected = catalog.Select(selectedSnapshot);
        var routeKey = selected.RawModel is not null && catalog.Contains(selected.RawModel) ? selected.RawModel : catalog.DefaultKey; var rawEffort = selected.RawEffort; var turnId = hosted.LogicalTurnId;
        var captured = requests.Capture(catalog, routeKey, rawEffort);
        var cacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        var notice = new ModelRetryNotice(hosted); var attempts = 0;
        async Task<string> Prompt(ConcreteHostModel leaf, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            var value = SessionWait.Text(hosted.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]) ?? "";
            if (ConditionalMemory.ReadCurrentModelSnapshotId(value) != leaf.Key)
            {
                value = await memory.BuildAsync(hosted.Agent, hosted.Id, leaf.Key);
                await hosted.Entry.SaveLane.CommitMemorySnapshotAsync(value);
            }
            return baseOptions.Instructions.Length == 0 ? value : baseOptions.Instructions + "\n\n" + value;
        }
        try
        {
            return await requests.RequestAsync(sessionId, captured, cacheKey, turnId, history, Prompt,
                notice.NotifyAsync, () => { if (++attempts > 1) hosted.RestartDraft(); }, progress,
                hosted.Entry.RecordBestEffortFailure, cancellationToken, ModelRequestScope.Canonical);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (ModelRequestException) { throw; }
        catch (Exception error) { throw new ModelPreparationException(ConfiguredModelRequests.SafeError(error, selected.Model), error); }
    }
}
