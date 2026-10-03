namespace Foxwarm.Sessions;

internal sealed class SessionOnbootProducer(string path, Func<string, CancellationToken, Task> enqueue, Action<string, Exception> report) : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly CancellationTokenSource stop = new();
    private TaskCompletionSource? completion;
    private bool closed;
    internal void Start()
    {
        TaskCompletionSource operation;
        lock (gate)
        {
            if (closed || completion is not null) return;
            operation = new(TaskCreationOptions.RunContinuationsAsynchronously); completion = operation;
        }
        _ = ProduceAsync(operation);
    }
    private async Task ProduceAsync(TaskCompletionSource operation)
    {
        var stage = "Error processing ONBOOT.md";
        try
        {
            var token = stop.Token; token.ThrowIfCancellationRequested();
            try { _ = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            var content = await File.ReadAllTextAsync(path, token);
            if (SessionGoal.Trim(content).Length == 0) return;
            await Task.Delay(TimeSpan.FromSeconds(3), token);
            token.ThrowIfCancellationRequested();
            stage = "Failed to queue ONBOOT event";
            await enqueue("ONBOOT: " + content, token);
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception error) { report(stage, error); }
        finally { operation.TrySetResult(); }
    }
    internal void Close()
    {
        lock (gate) { if (closed) return; closed = true; }
        stop.Cancel();
    }
    internal Task DrainAsync() { lock (gate) return completion?.Task ?? Task.CompletedTask; }
    public async ValueTask DisposeAsync() { Close(); await DrainAsync(); stop.Dispose(); }
}
