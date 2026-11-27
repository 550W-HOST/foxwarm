using System.Text.Json.Nodes;
using Foxwarm.Limits;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Limits;

// Configuration counts at save, read from the document the save replaces.
public sealed partial class TenantLimitAdmissionTests
{
    // Configuration documents whose synchronous read of the app configuration can be made to
    // fail: a remote store would block a thread there.
    private sealed class AsyncOnlyDocuments(IConfigDocumentStore inner) : IConfigDocumentStore
    {
        internal bool SyncReadFails;

        public string Locator(ConfigDocumentName name) => inner.Locator(name);

        public string? PhysicalPath(ConfigDocumentName name) => inner.PhysicalPath(name);

        public bool DirectEdits => inner.DirectEdits;

        public bool Exists(ConfigDocumentName name) => inner.Exists(name);

        public byte[]? Read(ConfigDocumentName name) =>
            SyncReadFails && name == ConfigDocumentName.Config
                ? throw new InvalidOperationException("Synchronous configuration read.")
                : inner.Read(name);

        public Task<byte[]?> ReadAsync(ConfigDocumentName name, CancellationToken token) =>
            Task.FromResult(inner.Read(name));

        public byte[]? ReadBounded(ConfigDocumentName name, int maxBytes) => inner.ReadBounded(name, maxBytes);

        public Task ReplaceAsync(
            ConfigDocumentName name,
            byte[] bytes,
            CancellationToken token,
            Action<AtomicJsonWriteStage>? stage = null
        ) => inner.ReplaceAsync(name, bytes, token, stage);

        public Task<bool> TryCreateAsync(ConfigDocumentName name, byte[] bytes, CancellationToken token) =>
            inner.TryCreateAsync(name, bytes, token);
    }

    [Fact]
    public async Task ConfigurationCountsReadTheSavedDocumentAsynchronously()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(Path.Combine(temp.Path, "data"), temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.Combine(paths.DataRoot, "state"));
        var documents = new AsyncOnlyDocuments(new FileConfigDocuments(paths));
        var config = new Foxwarm.Models.ModelConfiguration(
            paths,
            new Foxwarm.Models.ConfigurationSources(
                documents,
                new JsonObject(),
                hostPaths => new Foxwarm.Secrets.InstanceSecrets(hostPaths.DataRoot),
                new FileInstanceCredentials(paths.DataRoot)
            )
        )
        {
            Limits = Limits with { AccessIdentities = 2 },
        };
        await config.SaveAppAsync(Identities(2));
        documents.SyncReadFails = true;
        await config.SaveAppAsync(Identities(1));
        await Assert.ThrowsAsync<TenantLimitException>(() => config.SaveAppAsync(Identities(3)));
    }
}
