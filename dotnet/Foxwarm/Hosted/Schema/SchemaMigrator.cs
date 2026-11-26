using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Foxwarm.Hosted.Postgres;
using Npgsql;

namespace Foxwarm.Hosted.Schema;

/// <summary>One embedded schema migration.</summary>
/// <param name="ReaderFloor">
/// The lowest binary schema level that can still run against a database with this migration
/// applied. Expand-only migrations keep the floor of the previous schema.
/// </param>
internal sealed record SchemaMigration(
    int Version,
    string Name,
    string Sql,
    int ReaderFloor,
    string Sha256
);

/// <summary>An applied migration as <c>schema_migrations</c> records it.</summary>
internal sealed record AppliedMigration(int Version, string Name, string Sha256, int ReaderFloor);

/// <summary>A replica refused the database's schema.</summary>
internal sealed class SchemaIncompatibleException(string message) : Exception(message);

/// <summary>Compared state of the binary's migrations and a database's applied ones.</summary>
internal sealed record SchemaStatus(
    int BinaryLevel,
    IReadOnlyList<AppliedMigration> Applied,
    IReadOnlyList<SchemaMigration> Pending,
    IReadOnlyList<AppliedMigration> Unknown,
    IReadOnlyList<AppliedMigration> Changed
)
{
    /// <summary>Why a replica of this binary must not run against the database, or null.</summary>
    internal string? Refusal()
    {
        if (Changed.Count > 0)
            return "Applied migrations differ from this build's: "
                + string.Join(", ", Changed.Select(item => Label(item.Version, item.Name)))
                + ".";
        if (Pending.Count > 0)
            return "The database schema is older than this build; run `foxwarm db migrate`. Missing: "
                + string.Join(", ", Pending.Select(item => Label(item.Version, item.Name)))
                + ".";
        var newer = Unknown.Where(item => item.ReaderFloor > BinaryLevel).ToArray();
        if (newer.Length > 0)
            return $"The database schema requires schema level {newer.Max(item => item.ReaderFloor)} or later; this build has level {BinaryLevel}.";
        return null;
    }

    internal static string Label(int version, string name) =>
        version.ToString("D4", CultureInfo.InvariantCulture) + "_" + name;
}

/// <summary>
/// Applies the schema migrations embedded in this build, in version order, each in its own
/// transaction under one advisory lock. Migrations run only through this explicit operation
/// (<c>foxwarm db migrate</c>), never implicitly when a replica starts.
/// </summary>
internal static partial class SchemaMigrator
{
    // pg_advisory_xact_lock key shared by every migrating process ("foxwarm" in ASCII).
    private const long LockKey = 0x666F787761726D;

    private const string Bootstrap = """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version integer PRIMARY KEY,
            name text COLLATE "C" NOT NULL,
            sha256 text COLLATE "C" NOT NULL,
            reader_floor integer NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS schema_info (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            app_role text COLLATE "C" NOT NULL
        );
        ALTER TABLE schema_info ADD COLUMN IF NOT EXISTS operator_role text COLLATE "C";
        """;

    private static readonly Lazy<IReadOnlyList<SchemaMigration>> embedded = new(LoadEmbedded);

    /// <summary>This build's migrations, by version.</summary>
    internal static IReadOnlyList<SchemaMigration> Embedded => embedded.Value;

    /// <summary>This build's schema level: its highest migration version.</summary>
    internal static int BinaryLevel => Embedded.Count == 0 ? 0 : Embedded[^1].Version;

    [GeneratedRegex(@"^(\d{4})_([a-z0-9_]+)\.sql$")]
    private static partial Regex ResourceName();

    [GeneratedRegex(@"^--\s*reader-floor:\s*(\d+)\s*$", RegexOptions.Multiline)]
    private static partial Regex ReaderFloorHeader();

    internal static IReadOnlyList<SchemaMigration> Parse(IEnumerable<(string File, string Sql)> files)
    {
        var result = new List<SchemaMigration>();
        foreach (var (file, sql) in files)
        {
            var name = ResourceName().Match(file);
            if (!name.Success)
                throw new InvalidDataException($"Migration file name is malformed: {file}.");
            var header = ReaderFloorHeader().Match(sql);
            if (!header.Success || header.Index != 0)
                throw new InvalidDataException(
                    $"Migration {file} must start with a `-- reader-floor: N` line."
                );
            var version = int.Parse(name.Groups[1].Value, CultureInfo.InvariantCulture);
            var floor = int.Parse(header.Groups[1].Value, CultureInfo.InvariantCulture);
            if (version < 1 || floor < 1 || floor > version)
                throw new InvalidDataException(
                    $"Migration {file} has reader floor {floor}; it must be between 1 and its version."
                );
            result.Add(
                new(
                    version,
                    name.Groups[2].Value,
                    sql,
                    floor,
                    Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql)))
                )
            );
        }
        result.Sort((left, right) => left.Version.CompareTo(right.Version));
        for (var index = 1; index < result.Count; index++)
            if (result[index].Version == result[index - 1].Version)
                throw new InvalidDataException(
                    $"Two migrations have version {result[index].Version}."
                );
        return result;
    }

    private static IReadOnlyList<SchemaMigration> LoadEmbedded()
    {
        const string prefix = "Foxwarm.Hosted.Migrations.";
        var assembly = typeof(SchemaMigrator).Assembly;
        var files = new List<(string, string)>();
        foreach (var resource in assembly.GetManifestResourceNames())
        {
            if (!resource.StartsWith(prefix, StringComparison.Ordinal))
                continue;
            using var stream = assembly.GetManifestResourceStream(resource)!;
            using var reader = new StreamReader(stream, new UTF8Encoding(false, true));
            files.Add((resource[prefix.Length..], reader.ReadToEnd()));
        }
        return Parse(files);
    }

    /// <summary>
    /// Applies every missing migration as the schema owner, granting runtime privileges to
    /// <paramref name="appRole"/> and operator privileges to <paramref name="operatorRole"/>,
    /// then makes sure <paramref name="tenant"/> exists with its lease row. Both roles must
    /// exist and differ; a database keeps the roles it was first migrated with. Returns the
    /// migrations applied by this call.
    /// </summary>
    internal static async Task<IReadOnlyList<SchemaMigration>> MigrateAsync(
        PgDatabase owner,
        string appRole,
        string operatorRole,
        string? tenant,
        IReadOnlyList<SchemaMigration>? migrations = null,
        CancellationToken token = default
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(appRole);
        ArgumentException.ThrowIfNullOrWhiteSpace(operatorRole);
        if (appRole == operatorRole)
            throw new SchemaIncompatibleException(
                "The runtime and operator database roles must be different roles."
            );
        migrations ??= Embedded;
        var applied = new List<SchemaMigration>();
        await using var connection = await owner.OpenAsync(token).ConfigureAwait(false);
        await InTransactionAsync(
                connection,
                async transaction =>
                {
                    await ExecuteAsync(connection, transaction, Bootstrap, token).ConfigureAwait(false);
                    await using var role = new NpgsqlCommand(
                        "SELECT 1 FROM pg_roles WHERE rolname = $1",
                        connection,
                        transaction
                    );
                    role.Parameters.Add(new NpgsqlParameter<string> { TypedValue = appRole });
                    if (await role.ExecuteScalarAsync(token).ConfigureAwait(false) is null)
                        throw new SchemaIncompatibleException(
                            $"The runtime database role {appRole} doesn't exist; create it before migrating."
                        );
                    role.Parameters[0].Value = operatorRole;
                    if (await role.ExecuteScalarAsync(token).ConfigureAwait(false) is null)
                        throw new SchemaIncompatibleException(
                            $"The operator database role {operatorRole} doesn't exist; create it before migrating."
                        );
                    // A database migrated before the operator role existed records it now.
                    await using (var insert = new NpgsqlCommand(
                        "INSERT INTO schema_info (app_role, operator_role) VALUES ($1, $2)"
                            + " ON CONFLICT (singleton) DO UPDATE SET operator_role = $2"
                            + " WHERE schema_info.operator_role IS NULL",
                        connection,
                        transaction
                    ))
                    {
                        insert.Parameters.Add(new NpgsqlParameter<string> { TypedValue = appRole });
                        insert.Parameters.Add(new NpgsqlParameter<string> { TypedValue = operatorRole });
                        await insert.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                    }
                    await using var info = new NpgsqlCommand(
                        "SELECT app_role, operator_role FROM schema_info",
                        connection,
                        transaction
                    );
                    await using var reader = await info.ExecuteReaderAsync(token).ConfigureAwait(false);
                    await reader.ReadAsync(token).ConfigureAwait(false);
                    var recorded = reader.GetString(0);
                    var recordedOperator = reader.GetString(1);
                    if (recorded != appRole)
                        throw new SchemaIncompatibleException(
                            $"This database grants runtime privileges to {recorded}, not {appRole}."
                        );
                    if (recordedOperator != operatorRole)
                        throw new SchemaIncompatibleException(
                            $"This database grants operator privileges to {recordedOperator}, not {operatorRole}."
                        );
                },
                token
            )
            .ConfigureAwait(false);
        foreach (var migration in migrations)
        {
            var ran = false;
            await InTransactionAsync(
                    connection,
                    async transaction =>
                    {
                        var current = await ReadAppliedAsync(connection, transaction, token)
                            .ConfigureAwait(false);
                        if (current.FirstOrDefault(item => item.Version == migration.Version) is { } done)
                        {
                            if (done.Sha256 != migration.Sha256)
                                throw new SchemaIncompatibleException(
                                    $"Applied migration {SchemaStatus.Label(done.Version, done.Name)} differs from this build's."
                                );
                            return;
                        }
                        await using (var setting = new NpgsqlCommand(
                            "SELECT set_config('foxwarm.app_role', $1, true), set_config('foxwarm.operator_role', $2, true)",
                            connection,
                            transaction
                        ))
                        {
                            setting.Parameters.Add(new NpgsqlParameter<string> { TypedValue = appRole });
                            setting.Parameters.Add(new NpgsqlParameter<string> { TypedValue = operatorRole });
                            await setting.ExecuteScalarAsync(token).ConfigureAwait(false);
                        }
                        await ExecuteAsync(connection, transaction, migration.Sql, token)
                            .ConfigureAwait(false);
                        await using var record = new NpgsqlCommand(
                            "INSERT INTO schema_migrations (version, name, sha256, reader_floor) VALUES ($1, $2, $3, $4)",
                            connection,
                            transaction
                        );
                        record.Parameters.Add(new NpgsqlParameter<int> { TypedValue = migration.Version });
                        record.Parameters.Add(new NpgsqlParameter<string> { TypedValue = migration.Name });
                        record.Parameters.Add(new NpgsqlParameter<string> { TypedValue = migration.Sha256 });
                        record.Parameters.Add(new NpgsqlParameter<int> { TypedValue = migration.ReaderFloor });
                        await record.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                        ran = true;
                    },
                    token
                )
                .ConfigureAwait(false);
            if (ran)
                applied.Add(migration);
        }
        if (tenant is not null)
            await EnsureTenantAsync(connection, tenant, token).ConfigureAwait(false);
        return applied;
    }

    /// <summary>Compares the applied migrations with this build's.</summary>
    internal static async Task<SchemaStatus> StatusAsync(
        PgDatabase database,
        IReadOnlyList<SchemaMigration>? migrations = null,
        CancellationToken token = default
    )
    {
        migrations ??= Embedded;
        await using var connection = await database.OpenAsync(token).ConfigureAwait(false);
        IReadOnlyList<AppliedMigration> applied;
        await using (var exists = new NpgsqlCommand(
            "SELECT to_regclass('schema_migrations') IS NOT NULL",
            connection
        ))
            applied = (bool)(await exists.ExecuteScalarAsync(token).ConfigureAwait(false))!
                ? await ReadAppliedAsync(connection, null, token).ConfigureAwait(false)
                : [];
        var known = migrations.ToDictionary(item => item.Version);
        var level = migrations.Count == 0 ? 0 : migrations.Max(item => item.Version);
        return new(
            level,
            applied,
            migrations.Where(item => applied.All(done => done.Version != item.Version)).ToArray(),
            applied.Where(item => !known.ContainsKey(item.Version)).ToArray(),
            applied
                .Where(item => known.TryGetValue(item.Version, out var mine) && mine.Sha256 != item.Sha256)
                .ToArray()
        );
    }

    /// <summary>Throws <see cref="SchemaIncompatibleException"/> when this build must not run.</summary>
    internal static async Task RequireCompatibleAsync(
        PgDatabase database,
        IReadOnlyList<SchemaMigration>? migrations = null,
        CancellationToken token = default
    )
    {
        var status = await StatusAsync(database, migrations, token).ConfigureAwait(false);
        if (status.Refusal() is { } refusal)
            throw new SchemaIncompatibleException(refusal);
    }

    private static async Task EnsureTenantAsync(
        NpgsqlConnection connection,
        string tenant,
        CancellationToken token
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tenant);
        await using var command = new NpgsqlCommand(
            "WITH created AS (INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO NOTHING"
                + " RETURNING tenant_id)"
                + " INSERT INTO tenant_leases (tenant_id)"
                + " SELECT tenant_id FROM created UNION SELECT tenant_id FROM tenants WHERE name = $1"
                + " ON CONFLICT (tenant_id) DO NOTHING",
            connection
        );
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = tenant });
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }

    private static async Task<IReadOnlyList<AppliedMigration>> ReadAppliedAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        CancellationToken token
    )
    {
        await using var command = new NpgsqlCommand(
            "SELECT version, name, sha256, reader_floor FROM schema_migrations ORDER BY version",
            connection,
            transaction
        );
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        var result = new List<AppliedMigration>();
        while (await reader.ReadAsync(token).ConfigureAwait(false))
            result.Add(new(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetInt32(3)));
        return result;
    }

    private static async Task InTransactionAsync(
        NpgsqlConnection connection,
        Func<NpgsqlTransaction, Task> body,
        CancellationToken token
    )
    {
        await using var transaction = await connection.BeginTransactionAsync(token).ConfigureAwait(false);
        await using (var lockCommand = new NpgsqlCommand(
            "SELECT pg_advisory_xact_lock($1)",
            connection,
            transaction
        ))
        {
            lockCommand.Parameters.Add(new NpgsqlParameter<long> { TypedValue = LockKey });
            await lockCommand.ExecuteScalarAsync(token).ConfigureAwait(false);
        }
        await body(transaction).ConfigureAwait(false);
        await transaction.CommitAsync(token).ConfigureAwait(false);
    }

    private static async Task ExecuteAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string sql,
        CancellationToken token
    )
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
    }
}
