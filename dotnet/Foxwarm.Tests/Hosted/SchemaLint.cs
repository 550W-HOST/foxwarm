using Npgsql;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Structural rules every hosted table must follow. A tenant table carries a leading
/// <c>tenant_id</c> defaulted from the transaction's tenant, forced row-level security with a
/// policy, and the statement-level fence trigger on every write; every collatable column uses
/// byte ordering ("C") so paging and keyset order match the SQLite stores. Only the listed
/// cluster tables may lack a tenant. A cluster table has no row-level security, and the runtime
/// role (<c>schema_info.app_role</c>) only reads it: its writes go through lease-checked
/// functions, except the replica registration and lease acquisition listed in
/// <see cref="RuntimeClusterWrites"/>. It can't read operator credentials at all.
/// </summary>
internal static class SchemaLint
{
    internal static readonly string[] ClusterTables =
    [
        "tenants",
        "replicas",
        "tenant_leases",
        "schema_migrations",
        "schema_info",
        "tenant_hostnames",
        "tenant_wakeups",
        "provider_grants",
        "operator_documents",
        "operator_credentials",
        "tenant_auth",
        "operator_deletions",
    ];

    /// <summary>The runtime role's direct writes to cluster tables (P1's registry and leases).</summary>
    internal static readonly Dictionary<string, string[]> RuntimeClusterWrites = new()
    {
        ["replicas"] = ["INSERT", "UPDATE", "DELETE"],
        ["tenant_leases"] = ["UPDATE"],
    };

    // Cluster tables the runtime role mustn't read.
    private static readonly string[] RuntimeUnreadable = ["operator_credentials", "tenant_auth", "operator_deletions"];

    private const string ClusterPrivileges = """
        SELECT c.relname, c.relrowsecurity, p.privilege, has_table_privilege(i.app_role, c.oid, p.privilege)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (SELECT app_role FROM schema_info) i
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p (privilege)
         WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema() AND c.relname = ANY ($1)
         ORDER BY 1, 3
        """;

    // pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
    private const string Tables = """
        SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity,
               EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid),
               EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgrelid = c.oid AND t.tgfoid = 'foxwarm_fence'::regproc
                          AND t.tgenabled = 'O' AND (t.tgtype & 1) = 0 AND (t.tgtype & 2) = 2
                          AND (t.tgtype & 28) = 28),
               (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                 WHERE d.adrelid = c.oid AND a.attname = 'tenant_id'),
               (SELECT a.attnotnull FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped),
               EXISTS (SELECT 1 FROM pg_index x WHERE x.indrelid = c.oid AND x.indisprimary)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND n.nspname = current_schema()
         ORDER BY c.relname
        """;

    // Unique indexes (the primary key included) whose first column isn't tenant_id.
    private const string UniqueIndexes = """
        SELECT c.relname, i.relname, i_ix.indisprimary
          FROM pg_index i_ix
          JOIN pg_class c ON c.oid = i_ix.indrelid
          JOIN pg_class i ON i.oid = i_ix.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i_ix.indkey[0]
         WHERE n.nspname = current_schema() AND i_ix.indisunique
           AND c.relname <> ALL ($1) AND coalesce(a.attname, '') <> 'tenant_id'
         ORDER BY 1, 2
        """;

    private const string Collations = """
        SELECT c.relname, a.attname
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
           AND a.attnum > 0 AND NOT a.attisdropped AND a.attcollation <> 0
           AND a.attcollation NOT IN ('"C"'::regcollation, '"POSIX"'::regcollation)
         ORDER BY 1, 2
        """;

    internal static async Task<List<string>> ProblemsAsync(string connectionString)
    {
        var problems = new List<string>();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (var command = new NpgsqlCommand(Tables, connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync())
            {
                var table = reader.GetString(1);
                if (ClusterTables.Contains(table))
                    continue;
                if (reader.IsDBNull(7))
                {
                    problems.Add($"{table}: no tenant_id column (only cluster tables may lack one)");
                    continue;
                }
                if (!reader.GetBoolean(7))
                    problems.Add($"{table}: tenant_id is nullable");
                var fallback = reader.IsDBNull(6) ? "" : reader.GetString(6);
                if (!fallback.Contains("current_setting('foxwarm.tenant'", StringComparison.Ordinal))
                    problems.Add($"{table}: tenant_id doesn't default to the transaction's tenant");
                if (!reader.GetBoolean(2) || !reader.GetBoolean(3))
                    problems.Add($"{table}: row-level security isn't enabled and forced");
                if (!reader.GetBoolean(4))
                    problems.Add($"{table}: no row-level security policy");
                if (!reader.GetBoolean(8))
                    problems.Add($"{table}: no primary key");
                if (!reader.GetBoolean(5))
                    problems.Add($"{table}: no statement-level foxwarm_fence trigger on INSERT, UPDATE and DELETE");
            }
        await using (var command = new NpgsqlCommand(UniqueIndexes, connection))
        {
            command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = ClusterTables });
            await using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
                problems.Add(
                    $"{reader.GetString(0)}: {(reader.GetBoolean(2) ? "primary key" : "unique index")} {reader.GetString(1)} doesn't start with tenant_id"
                );
        }
        await using (var command = new NpgsqlCommand(ClusterPrivileges, connection))
        {
            command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = ClusterTables });
            await using var reader = await command.ExecuteReaderAsync();
            var reported = new HashSet<string>();
            while (await reader.ReadAsync())
            {
                var table = reader.GetString(0);
                if (reader.GetBoolean(1) && reported.Add(table))
                    problems.Add($"{table}: cluster tables have no row-level security");
                var privilege = reader.GetString(2);
                var granted = reader.GetBoolean(3);
                var allowed = privilege == "SELECT"
                    ? !RuntimeUnreadable.Contains(table)
                    : RuntimeClusterWrites.TryGetValue(table, out var writes) && writes.Contains(privilege);
                if (granted && !allowed)
                    problems.Add($"{table}: the runtime role has {privilege}");
            }
        }
        await using (var command = new NpgsqlCommand(Collations, connection))
        await using (var reader = await command.ExecuteReaderAsync())
            while (await reader.ReadAsync())
                problems.Add($"{reader.GetString(0)}.{reader.GetString(1)}: collation isn't \"C\"");
        return problems;
    }
}
