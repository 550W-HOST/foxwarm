namespace Foxwarm.Channels;

internal interface IManagedChannel : IAsyncDisposable
{
    RegisteredChannel Transport { get; }
    Task StartAsync();
    Task StopAsync();
}
