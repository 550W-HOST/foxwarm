using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Runs existing test classes against the hosted stores. With FOXWARM_TEST_BACKEND=postgres
/// (read only here, in the test assembly), every <see cref="SessionManager"/> built without
/// an explicit context gets a <see cref="PostgresStorageContext"/> on its own database, one per
/// data root, so a manager reopened on the same root sees the same state. Stores the build
/// has no PostgreSQL implementation for yet come from the file context under the same root;
/// such a mixed context exists only in tests. Classes qualified for both backends carry
/// <c>[Trait("Backend", "neutral")]</c>; the hosted CI job runs them a second time this way.
/// </summary>
internal static class HostedTestBackend
{
    internal const string Variable = "FOXWARM_TEST_BACKEND";

    private static readonly ConcurrentDictionary<string, Lazy<Tenant>> tenants = new();

    internal static bool Active { get; private set; }

    /// <summary>The key-encryption key of every test tenant, generated per test process.</summary>
    internal static readonly KeyEncryptionKey Kek = KeyEncryptionKey.From(
        Foxwarm.Secrets.InstanceKeys.FromKey(
            "test-kek",
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(32),
            "test"
        )
    );

    [ModuleInitializer]
    internal static void Initialize()
    {
        switch (Environment.GetEnvironmentVariable(Variable))
        {
            case null or "" or "file":
                return;
            case "postgres":
                Active = true;
                SessionManager.StorageForTests = Create;
                return;
            default:
                throw new InvalidOperationException($"{Variable} must be `file` or `postgres`.");
        }
    }

    /// <summary>A context for <paramref name="root"/>, sharing the root's database with earlier ones.</summary>
    internal static IStorageContext Create(string root)
    {
        var full = Path.GetFullPath(root);
        var tenant = tenants.GetOrAdd(full, key => new Lazy<Tenant>(() => Open(key))).Value;
        return Compose(
            new PostgresStorageContext(tenant.Database, full)
            {
                KeyRing = new HostedKeyRing(tenant.Database, Kek),
            },
            full
        );
    }

    /// <summary>The owner access to the database behind <paramref name="root"/>, once one exists; for fault injection.</summary>
    internal static HostedTestDatabase? Database(string root) =>
        tenants.TryGetValue(Path.GetFullPath(root), out var tenant) && tenant.IsValueCreated
            ? tenant.Value.Owner
            : null;

    /// <summary>The hosted stores that exist and file stores under <paramref name="root"/> for the rest.</summary>
    internal static IStorageContext Compose(PostgresStorageContext hosted, string root) =>
        hosted.Missing.Count == 0 ? hosted : new MixedStorageContext(hosted, new FileStorageContext(root));

    private static Tenant Open(string root)
    {
        var server = PostgresServer.SharedAsync().GetAwaiter().GetResult();
        var database = server.CreateDatabaseAsync().GetAwaiter().GetResult();
        var tenantId = database.TenantIdAsync().GetAwaiter().GetResult();
        var epoch = database.TakeLeaseAsync(tenantId, "test:" + root).GetAwaiter().GetResult();
        return new Tenant(database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    private sealed record Tenant(HostedTestDatabase Owner, TenantDb Database);

    /// <summary>The hosted stores that exist, the file stores for the rest.</summary>
    private sealed class MixedStorageContext(PostgresStorageContext hosted, FileStorageContext file)
        : IStorageContext
    {
        // Authority, Archive and the identity ledger are one group: the file Authority writes
        // the SQLite Archive directly and a move rewrites all three, so they come from one side.
        private static readonly string[] SessionGroup = ["Authority", "Archive", "Identities"];
        private readonly HashSet<string> missing = Missing(hosted);

        private static HashSet<string> Missing(PostgresStorageContext hosted)
        {
            var missing = new HashSet<string>(hosted.Missing);
            if (SessionGroup.Any(missing.Contains))
                missing.UnionWith(SessionGroup);
            return missing;
        }

        private T Pick<T>(Func<IStorageContext, T> store, [CallerMemberName] string name = "") =>
            store(missing.Contains(name) ? file : hosted);

        public ISessionAuthorityBackend Authority => Pick(context => context.Authority);

        public IArchiveStore Archive => Pick(context => context.Archive);

        public IIdentityLedger Identities => Pick(context => context.Identities);

        public ISessionCatalogStore Catalog => Pick(context => context.Catalog);

        public ITaskRowStore Tasks => Pick(context => context.Tasks);

        public Foxwarm.Models.ILlmJournalStore Journal => Pick(context => context.Journal);

        public Foxwarm.ToolScript.IToolScriptRunStore ToolScriptRuns => Pick(context => context.ToolScriptRuns);

        public IStateDocuments Documents => Pick(context => context.Documents);

        public IInstanceCredentials Credentials => Pick(context => context.Credentials);

        public IBlobStore ImageBlobs => Pick(context => context.ImageBlobs);

        public IBlobStore ArtifactBlobs => Pick(context => context.ArtifactBlobs);
    }
}
