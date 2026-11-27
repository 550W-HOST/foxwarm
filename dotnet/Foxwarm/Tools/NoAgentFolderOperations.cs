namespace Foxwarm.Tools;

/// <summary>
/// The Main-local file target of an Agent without a folder (its files are in an Agent store):
/// every operation fails as a call to the missing master Node does.
/// </summary>
internal sealed class NoAgentFolderOperations : ITargetFileOperations
{
    internal static readonly NoAgentFolderOperations Instance = new();

    private static Exception Refused() => RuntimeCapabilities.NoCurrentNode();

    public Task<TargetFileStat> StatAsync(string path, CancellationToken token) => throw Refused();

    public Task<byte[]> ReadAsync(string path, long offset, int count, CancellationToken token) =>
        throw Refused();

    public Task<IReadOnlyList<TargetFileStat>> ReadDirectoryAsync(string path, CancellationToken token) =>
        throw Refused();

    public Task<string> ParentAsync(string path, CancellationToken token) => throw Refused();

    public Task WriteAsync(string path, byte[] bytes, string flag, CancellationToken token) => throw Refused();

    public Task MakeDirectoryAsync(string path, CancellationToken token) => throw Refused();

    public Task RemoveAsync(string path, CancellationToken token) => throw Refused();
}
