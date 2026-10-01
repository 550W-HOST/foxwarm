using System.Text.Json.Nodes;
using Foxwarm.Sessions;
namespace Foxwarm.Models;

internal sealed class SessionChatService(
    HttpClient http, ResponsesClientOptions baseOptions, SessionOwner hosted, HostModels models, AgentMemory memory,
    Action<string, ResponsesStreamProgress> progress) : IChatService
{
    public async Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken)
    {
        var selectedSnapshot = hosted.Entry.Snapshot();
        var catalog = models.Capture();
        var selected = catalog.Select(selectedSnapshot);
        var cacheKey = await hosted.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        var turnId = hosted.LogicalTurnId;
        var prompt = selectedSnapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        if (ConditionalMemory.ReadCurrentModelSnapshotId(prompt) != selected.Model.Key)
        {
            prompt = await memory.BuildAsync(hosted.Agent, hosted.Id, selected.Model.Key);
            await hosted.Entry.SaveLane.CommitMemorySnapshotAsync(prompt);
        }
        try
        {
            var options = ConfiguredModelRequests.Plan(selected.Model, baseOptions, selected.EffectiveEffort,
                baseOptions.Instructions.Length == 0 ? prompt : baseOptions.Instructions + "\n\n" + prompt, cacheKey, turnId);
            return await ConfiguredModelRequests.CreateService(http, selected.Model, options, cacheKey, progress).ChatAsync(sessionId, history, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception error) { throw new InvalidDataException(ConfiguredModelRequests.SafeError(error, selected.Model)); }
    }
}
