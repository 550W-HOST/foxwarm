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
        var selected = models.Select(selectedSnapshot);
        var prompt = selectedSnapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        if (ConditionalMemory.ReadCurrentModelSnapshotId(prompt) != selected.Model.Key)
        {
            prompt = await memory.BuildAsync(hosted.Agent, hosted.Id, selected.Model.Key);
            await hosted.Entry.SaveLane.CommitMemorySnapshotAsync(prompt);
        }
        var options = baseOptions with
        {
            BaseUri = selected.Model.BaseUri,
            RequestModel = selected.Model.ModelId,
            ConcreteModelId = selected.Model.Key,
            Token = selected.Model.Token,
            Effort = selected.EffectiveEffort,
            Instructions = baseOptions.Instructions.Length == 0 ? prompt : baseOptions.Instructions + "\n\n" + prompt
        };
        return await new ResponsesChatService(http, options, progress).ChatAsync(sessionId, history, cancellationToken);
    }
}
