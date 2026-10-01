using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

public sealed class CancellationHandle : IDisposable
{
    private int disposed;
    internal CancellationHandle(CancellationTokenSource source) { Source = source; Token = source.Token; }
    internal CancellationTokenSource Source { get; }
    internal bool TakenByStop { get; set; }
    // Stop may dispose the source while an already-started tool finishes its paired response.
    public CancellationToken Token { get; }
    public void Cancel() => Source.Cancel();
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) Source.Dispose();
    }
}

public interface IChatService
{
    Task<ChatResult> ChatAsync(string sessionId, IReadOnlyList<JsonObject> history, CancellationToken cancellationToken);
}

public interface ITurnToolExecutor
{
    Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken);
}

/// <summary>A successful handoff ends only after its complete paired tool batch is committed.</summary>
public interface ITurnToolControl
{
    void BeginTurn();
    bool ConsumeFinishAfterBatch();
    Task<bool> CompleteBatchAsync(JsonObject toolMessage, bool stopping) => Task.FromResult(ConsumeFinishAfterBatch());
}

public sealed class UnsupportedTurnToolExecutor : ITurnToolExecutor
{
    public Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>() ?? "";
        return Task.FromResult(ToolError("unknown_tool", $"Unknown tool: {name}"));
    }

    public static JsonObject ToolError(string type, string message) => new()
    {
        ["error"] = new JsonObject { ["type"] = type, ["message"] = message }
    };
}

public sealed class ToolLoopLimitException(int limit)
    : InvalidOperationException($"Experimental Session turn exceeded the {limit} iteration tool-loop limit.");

public sealed record ChatResult(JsonObject? AssistantMessage, JsonObject? Usage = null)
{
    public static ChatResult Text(string text) => new(new JsonObject
    {
        ["role"] = "model",
        ["parts"] = new JsonArray(new JsonObject { ["text"] = text })
    });
}

public sealed class UnsupportedSessionTurnException : InvalidOperationException
{
    public string Path { get; }
    public UnsupportedSessionTurnException(string path) : base($"Experimental Session turns do not support {path}.") => Path = path;
}
