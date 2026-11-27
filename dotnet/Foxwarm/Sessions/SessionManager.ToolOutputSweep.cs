namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    /// <summary>How long a spilled tool output stays in an Agent store.</summary>
    internal static readonly TimeSpan ToolOutputRetention = TimeSpan.FromHours(24);

    private const string ToolOutputDirectory = ".temp/tool-output";

    // Over an Agent store, spilled tool outputs older than the retention are removed at start
    // and then hourly. Received files and uploads stay; file mode has no sweep.
    private Task? toolOutputSweep;

    private async Task RunToolOutputSweepAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        try
        {
            do
            {
                try
                {
                    await SweepToolOutputAsync(DateTime.UtcNow, token);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    Console.Error.WriteLine("Tool output sweep failed: " + error.Message);
                }
            } while (await timer.WaitForNextTickAsync(token));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    /// <summary>
    /// Removes the spilled tool outputs of every Agent last written before
    /// <paramref name="now"/> minus the retention. A file replaced meanwhile is kept: each
    /// removal is conditional on the generation that was seen.
    /// </summary>
    internal async Task<int> SweepToolOutputAsync(DateTime now, CancellationToken token)
    {
        if (AgentStore is not { } store)
            return 0;
        var cutoff = now - ToolOutputRetention;
        var removed = 0;
        foreach (var agent in store.Agents())
        {
            token.ThrowIfCancellationRequested();
            if (store.Stat(agent, ToolOutputDirectory) is not { IsDirectory: true })
                continue;
            foreach (var entry in store.Tree(agent, ToolOutputDirectory))
            {
                if (entry.IsDirectory || entry.LastWriteUtc >= cutoff)
                    continue;
                try
                {
                    await store.DeleteAsync(agent, entry.Path, recursive: false, entry.Generation, token);
                    removed++;
                }
                catch (Exception error) when (error is AgentFileConflictException or FileNotFoundException or DirectoryNotFoundException)
                {
                    // Changed or gone since it was listed.
                }
            }
        }
        return removed;
    }
}
