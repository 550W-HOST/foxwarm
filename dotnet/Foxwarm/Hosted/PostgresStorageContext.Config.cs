using Foxwarm.Hosted.Postgres;
using Foxwarm.Storage;

namespace Foxwarm.Hosted;

internal sealed partial class PostgresStorageContext
{
    /// <summary>
    /// The tenant's key ring. The hosted entry opens it before the runtime is built, so a locked
    /// tenant never starts; the credentials store derives its key from it.
    /// </summary>
    internal HostedKeyRing? KeyRing { get; set; }

    /// <summary>The tenant configuration documents, written under this replica's name.</summary>
    internal PgConfigDocuments ConfigDocuments(string? writer) => new(Database, writer);

    partial void CreateCredentials(ref IInstanceCredentials? store) =>
        store = new PgInstanceCredentials(
            Database,
            () =>
                (
                    KeyRing
                    ?? throw new InvalidOperationException("The tenant key ring isn't open.")
                ).OpenOrCreate()
        );
}
