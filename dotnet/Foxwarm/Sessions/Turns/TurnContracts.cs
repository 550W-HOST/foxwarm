using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal sealed class SessionTurnShutdownException()
    : OperationCanceledException("Session processing is shutting down.");

internal sealed class SessionTurnDrainException(Exception? inner = null)
    : TimeoutException("Accepted Session work did not settle during shutdown.", inner);

public sealed class CancellationHandle : IDisposable
{
    private int disposed;

    internal CancellationHandle(CancellationTokenSource source)
    {
        Source = source;
        Token = source.Token;
    }

    internal CancellationTokenSource Source { get; }
    internal bool TakenByStop { get; set; }

    // Stop may dispose the source while an already-started tool finishes its paired response.
    public CancellationToken Token { get; }

    public void Cancel() => Source.Cancel();

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0)
            Source.Dispose();
    }
}

public interface IChatService
{
    Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    );
}

/// <summary>Ordinary owner chat may prepare committed input before a real provider retry.</summary>
public interface ISessionChatService : IChatService
{
    Task<ChatResult> ChatAsync(
        string sessionId,
        SessionHistory history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        CancellationToken cancellationToken
    );

    Task<ChatResult> ChatAsync(
        string sessionId,
        SessionHistory history,
        Func<CancellationToken, Task<bool>> prepareRetry,
        Func<JsonObject, bool, Task<JsonObject>> commitAssistantSegment,
        CancellationToken cancellationToken,
        int iteration = 0
    ) => ChatAsync(sessionId, history, prepareRetry, cancellationToken);
}

public interface ITurnToolExecutor
{
    Task<JsonNode?> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken);
}

public enum TurnBatchEnding
{
    Continue,
    Finished,
    Suspended,
}

/// <summary>A successful handoff ends only after its complete paired tool batch is committed.</summary>
public interface ITurnToolControl
{
    void BeginTurn();
    bool PolicyUnavailable => false;
    bool ConsumeFinishAfterBatch();
    Task<TurnBatchEnding> CompleteBatchAsync(JsonObject toolMessage, bool stopping) =>
        Task.FromResult(
            ConsumeFinishAfterBatch() ? TurnBatchEnding.Finished : TurnBatchEnding.Continue
        );
}

public sealed class UnsupportedTurnToolExecutor : ITurnToolExecutor
{
    public Task<JsonNode?> ExecuteAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>() ?? "";
        return Task.FromResult<JsonNode?>(ToolError("unknown_tool", $"Unknown tool: {name}"));
    }

    public static JsonObject ToolError(string type, string message) =>
        new()
        {
            ["error"] = new JsonObject { ["type"] = type, ["message"] = message },
        };
}

public sealed class ToolLoopLimitException(int limit)
    : InvalidOperationException($"Session turn exceeded the {limit} iteration tool-loop limit.");

public sealed record ChatResult(
    JsonObject? AssistantMessage,
    JsonObject? Usage = null,
    string? JournalRequestId = null,
    int? JournalAttempt = null
)
{
    internal HistoryAppendFinalizer? HistoryAppend { get; init; }
    internal IReadOnlyList<JsonObject> CommittedSegments { get; init; } = [];
    internal bool Terminal { get; init; }
    internal bool Suspended { get; init; }
    internal bool ContextCompacted { get; init; }
    internal string? TruncatedStopReason { get; init; }

    internal void FinalizeHistory(
        IReadOnlyList<JsonObject>? rows,
        Action<Exception>? warning = null
    ) => HistoryAppend?.Settle(rows, warning);

    public static ChatResult Text(string text) =>
        new(
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            }
        );
}

public sealed class UnsupportedSessionTurnException : InvalidOperationException
{
    public string Path { get; }

    public UnsupportedSessionTurnException(string path)
        : base($"Session turns do not support {path}.") => Path = path;
}

internal sealed class HistoryAppendFinalizer(Action<IReadOnlyList<JsonObject>?> finalize)
{
    private int settled;

    internal void Settle(IReadOnlyList<JsonObject>? rows, Action<Exception>? warning)
    {
        if (Interlocked.Exchange(ref settled, 1) != 0)
            return;
        try
        {
            finalize(rows);
        }
        catch (Exception error)
        {
            try
            {
                warning?.Invoke(error);
            }
            catch { }
        }
    }
}
