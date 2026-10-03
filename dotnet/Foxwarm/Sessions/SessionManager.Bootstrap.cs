using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private SessionOnbootProducer? onboot;
    internal async Task LoadMainHostAsync()
    {
        await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
        await LoadOwnersAsync(ensureMain: true);
        onboot = new(Path.Combine(agents.MemoryDirectory("main"), "ONBOOT.md"), QueueOnbootAsync,
            (stage, error) => Console.Error.WriteLine(stage + ": " + error));
    }
    private async Task<SessionOwner> EnsureStartupMainAsync()
    {
        if (await GetExistingAsync("main") is { } existing) return existing;
        using var operation = TrackCreation();
        var gate = CreationKey("main"); await gate.WaitAsync();
        try { return await GetExistingAsync("main") ?? await CreateNamedLockedAsync("main", "main", null, null, null, null, startupMain: true); }
        finally { gate.Release(); }
    }
    internal void StartOnboot() => (onboot ?? throw new InvalidOperationException("Main host bootstrap has not completed.")).Start();
    private async Task QueueOnbootAsync(string message, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var owner = await RequiredAsync("main", token);
        if (!Accepting || !IsCurrentOwner(owner)) throw new InvalidOperationException("ONBOOT Session owner is unavailable.");
        var wrapper = SessionBoundary.SessionEvent("onboot", message);
        var item = new QueueItem(QueueItemType.OnBoot, [new JsonObject { ["system"] = wrapper }]);
        bool admitted;
        try { admitted = await owner.Entry.SaveLane.AdmitAsync(item, SaveKind.Strict); }
        catch (AuthorityCommittedException)
        {
            if (Accepting && IsCurrentOwner(owner) && owner.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) _ = owner.StartProcessing();
            throw;
        }
        if (Accepting && admitted && IsCurrentOwner(owner) && owner.Entry.WithState(state => !state.Busy && !state.Stopping && state.Queue.Count > 0)) _ = owner.StartProcessing();
    }
}
