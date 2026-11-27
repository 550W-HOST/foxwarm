using Foxwarm.Sessions;

namespace Foxwarm.Storage;

/// <summary>
/// One runtime's persistent state. It is built once, at the host entry or by a test, and domain
/// code receives its stores instead of data-root paths. File mode keeps today's files under one
/// data directory (<see cref="FileStorageContext"/>).
/// </summary>
internal interface IStorageContext
{
    ISessionAuthorityBackend Authority { get; }
}

/// <summary>Construction seams of the file stores, used only by tests.</summary>
internal sealed record FileStorageOptions(
    Action<string, AtomicJsonWriteStage>? AuthorityStageHook = null,
    Func<string, int, CancellationToken, Task>? CanonicalCommitBarrier = null
);

/// <summary>Today's file and SQLite stores under one data directory.</summary>
internal sealed class FileStorageContext : IStorageContext
{
    internal FileStorageContext(string dataRoot, FileStorageOptions? options = null)
    {
        DataRoot = Path.GetFullPath(dataRoot);
        Authority = new FileSessionAuthorityBackend(
            DataRoot,
            options?.AuthorityStageHook,
            options?.CanonicalCommitBarrier
        );
    }

    internal string DataRoot { get; }

    public ISessionAuthorityBackend Authority { get; }
}
