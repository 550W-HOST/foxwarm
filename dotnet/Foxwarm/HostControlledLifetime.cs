namespace Foxwarm;

/// <summary>
/// The lifetime of a tenant runtime's host: it neither waits for nor reacts to process signals.
/// Only the replica owns SIGTERM and SIGINT; a tenant's host stops when the replica stops it.
/// </summary>
internal sealed class HostControlledLifetime : Microsoft.Extensions.Hosting.IHostLifetime
{
    public Task WaitForStartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
