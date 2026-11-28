using System.Diagnostics;
using System.Security.Cryptography;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// One disposable PostgreSQL server per test process, with a migrated template database that
/// every test copies. Configure it with FOXWARM_TEST_PG_PREFIX (an extracted PGDG prefix; the
/// fixture runs its own cluster under a short /tmp path, reachable only through a Unix socket)
/// or FOXWARM_TEST_PG_URL (an existing server and a superuser connection string). These
/// variables are read only here, in the test assembly.
/// </summary>
internal sealed class PostgresServer
{
    internal const string PrefixVariable = "FOXWARM_TEST_PG_PREFIX";
    internal const string UrlVariable = "FOXWARM_TEST_PG_URL";
    internal const string OwnerRole = "foxwarm_test_owner";
    internal const string AppRole = "foxwarm_test_app";
    internal const string OperatorRole = "foxwarm_test_operator";
    internal const string Tenant = "default";

    private static readonly Lazy<Task<PostgresServer>> shared = new(StartAsync);
    private static int databaseCounter;

    private readonly string superuser;
    private readonly string ownerPassword;
    private readonly string appPassword;
    private readonly string operatorPassword;

    private PostgresServer(
        string superuser,
        string ownerPassword,
        string appPassword,
        string operatorPassword,
        string template,
        string? socketDirectory
    )
    {
        this.superuser = superuser;
        this.ownerPassword = ownerPassword;
        this.appPassword = appPassword;
        this.operatorPassword = operatorPassword;
        Template = template;
        SocketDirectory = socketDirectory;
    }

    internal static bool Configured =>
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(PrefixVariable))
        || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(UrlVariable));

    internal string Template { get; }

    /// <summary>The server's socket directory in prefix mode; null in URL mode.</summary>
    internal string? SocketDirectory { get; }

    internal static Task<PostgresServer> SharedAsync() =>
        Configured
            ? shared.Value
            : throw new InvalidOperationException(
                $"Hosted tests need PostgreSQL: set {PrefixVariable} to an extracted PGDG prefix or {UrlVariable} to a superuser connection string."
            );

    internal string Superuser(string database) =>
        new NpgsqlConnectionStringBuilder(superuser) { Database = database, Pooling = false }.ConnectionString;

    internal string Owner(string database) =>
        new NpgsqlConnectionStringBuilder(superuser)
        {
            Database = database,
            Username = OwnerRole,
            Password = ownerPassword,
            Pooling = false,
        }.ConnectionString;

    internal string App(string database) =>
        new NpgsqlConnectionStringBuilder(superuser)
        {
            Database = database,
            Username = AppRole,
            Password = appPassword,
        }.ConnectionString;

    internal string Operator(string database) =>
        new NpgsqlConnectionStringBuilder(superuser)
        {
            Database = database,
            Username = OperatorRole,
            Password = operatorPassword,
            Pooling = false,
        }.ConnectionString;

    /// <summary>A fresh database copied from the migrated template, or an empty one.</summary>
    internal async Task<HostedTestDatabase> CreateDatabaseAsync(bool migrated = true)
    {
        var name =
            $"fw_test_{Environment.ProcessId}_{Interlocked.Increment(ref databaseCounter)}";
        await ExecuteAsync(
            Superuser("postgres"),
            migrated
                ? $"CREATE DATABASE {name} TEMPLATE {Template} OWNER {OwnerRole}"
                : $"CREATE DATABASE {name} OWNER {OwnerRole}"
        );
        return new HostedTestDatabase(this, name);
    }

    internal static async Task ExecuteAsync(string connectionString, string sql)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<PostgresServer> StartAsync()
    {
        var url = Environment.GetEnvironmentVariable(UrlVariable);
        string superuser;
        string? socketDirectory = null;
        if (!string.IsNullOrEmpty(url))
            superuser = PgConnectionString.Normalize(url);
        else
            (superuser, socketDirectory) = await StartClusterAsync(
                Environment.GetEnvironmentVariable(PrefixVariable)!
            );
        var ownerPassword = Secret();
        var appPassword = Secret();
        var operatorPassword = Secret();
        var template = $"fw_template_{Environment.ProcessId}";
        var server = new PostgresServer(superuser, ownerPassword, appPassword, operatorPassword, template, socketDirectory);
        var admin = server.Superuser("postgres");
        foreach (var (role, password) in new[] { (OwnerRole, ownerPassword), (AppRole, appPassword), (OperatorRole, operatorPassword) })
            await ExecuteAsync(
                admin,
                $"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN"
                    + $" CREATE ROLE {role} LOGIN; END IF; END $$;"
                    + $" ALTER ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'"
            );
        await ExecuteAsync(admin, $"DROP DATABASE IF EXISTS {template} WITH (FORCE)");
        await ExecuteAsync(admin, $"CREATE DATABASE {template} OWNER {OwnerRole}");
        await using (var owner = new PgDatabase(server.Owner(template), "foxwarm-test-migrate"))
            await SchemaMigrator.MigrateAsync(owner, AppRole, OperatorRole);
        await ExecuteAsync(server.Owner(template), $"WITH t AS (INSERT INTO tenants(name) VALUES ('{Tenant}') RETURNING tenant_id) INSERT INTO tenant_leases(tenant_id) SELECT tenant_id FROM t");
        if (socketDirectory is null)
            AppDomain.CurrentDomain.ProcessExit += (_, _) => DropDatabasesBestEffort(admin);
        return server;
    }

    // URL mode shares a server with other runs: remove this process's databases at exit.
    private static void DropDatabasesBestEffort(string admin)
    {
        try
        {
            using var connection = new NpgsqlConnection(admin);
            connection.Open();
            var names = new List<string>();
            using (var list = new NpgsqlCommand(
                "SELECT datname FROM pg_database WHERE datname LIKE $1 OR datname = $2",
                connection
            ))
            {
                list.Parameters.Add(new NpgsqlParameter<string> { TypedValue = $"fw\\_test\\_{Environment.ProcessId}\\_%" });
                list.Parameters.Add(new NpgsqlParameter<string> { TypedValue = $"fw_template_{Environment.ProcessId}" });
                using var reader = list.ExecuteReader();
                while (reader.Read())
                    names.Add(reader.GetString(0));
            }
            foreach (var name in names)
            {
                using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS {name} WITH (FORCE)", connection);
                drop.ExecuteNonQuery();
            }
        }
        catch { }
    }

    private static async Task<(string Superuser, string SocketDirectory)> StartClusterAsync(
        string prefix
    )
    {
        var bin = Path.Combine(prefix, "usr", "lib", "postgresql", "18", "bin");
        if (!File.Exists(Path.Combine(bin, "postgres")))
            throw new InvalidOperationException($"{PrefixVariable} has no usr/lib/postgresql/18/bin/postgres: {prefix}");
        var libraries = Directory
            .GetDirectories(Path.Combine(prefix, "usr", "lib"), "*-linux-gnu")
            .FirstOrDefault();
        // Unix socket paths are limited to about 100 bytes, so the cluster lives in a short path.
        var root = Path.Combine("/tmp", "fwpg-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6)));
        Directory.CreateDirectory(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var data = Path.Combine(root, "data");
        var password = Secret();
        var passwordFile = Path.Combine(root, "pw");
        await File.WriteAllTextAsync(passwordFile, password);
        var environment = new Dictionary<string, string?> { ["LD_LIBRARY_PATH"] = libraries, ["LC_ALL"] = "C.UTF-8" };
        await RunAsync(
            Path.Combine(bin, "initdb"),
            ["-D", data, "-U", "fw_super", "--auth=scram-sha-256", "--pwfile=" + passwordFile,
             "-E", "UTF8", "--locale-provider=icu", "--icu-locale=und", "--locale=C.UTF-8"],
            environment
        );
        File.Delete(passwordFile);
        var options =
            $"-k {root} -c listen_addresses='' -c fsync=off -c synchronous_commit=off"
            + " -c full_page_writes=off -c max_connections=200";
        await RunAsync(
            Path.Combine(bin, "pg_ctl"),
            ["-D", data, "-l", Path.Combine(root, "server.log"), "-w", "-t", "60", "-o", options, "start"],
            environment
        );
        var stop = $"LD_LIBRARY_PATH='{libraries}' '{Path.Combine(bin, "pg_ctl")}' -D '{data}' stop -m immediate >/dev/null 2>&1; rm -rf '{root}'";
        // Removes the cluster when this process ends, also when it is killed.
        var watcher = new ProcessStartInfo("setsid")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[] { "sh", "-c", $"exec </dev/null >/dev/null 2>&1; while kill -0 {Environment.ProcessId} 2>/dev/null; do sleep 2; done; {stop}" })
            watcher.ArgumentList.Add(argument);
        Process.Start(watcher)!.Dispose();
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try
            {
                using var process = Process.Start(new ProcessStartInfo("sh", ["-c", stop]) { UseShellExecute = false })!;
                process.WaitForExit(10_000);
            }
            catch { }
        };
        return (
            new NpgsqlConnectionStringBuilder
            {
                Host = root,
                Username = "fw_super",
                Password = password,
                Database = "postgres",
                SslMode = SslMode.Disable,
            }.ConnectionString,
            root
        );
    }

    private static async Task RunAsync(
        string file,
        string[] arguments,
        Dictionary<string, string?> environment
    )
    {
        var start = new ProcessStartInfo(file)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
            start.ArgumentList.Add(argument);
        foreach (var (key, value) in environment)
            start.Environment[key] = value;
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
            throw new InvalidOperationException(
                $"{Path.GetFileName(file)} failed with exit code {process.ExitCode}: {await output}{await error}"
            );
    }

    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}

/// <summary>
/// One test's own database, copied from the migrated template and dropped on dispose, so tests
/// never share rows. The tenant <see cref="PostgresServer.Tenant"/> exists with a released lease.
/// </summary>
internal sealed class HostedTestDatabase : IAsyncDisposable
{
    private readonly PostgresServer server;
    private readonly List<PgDatabase> opened = [];

    internal HostedTestDatabase(PostgresServer server, string name)
    {
        this.server = server;
        Name = name;
    }

    internal string Name { get; }

    internal PostgresServer Server => server;

    internal string AppConnectionString => server.App(Name);

    internal string OwnerConnectionString => server.Owner(Name);

    internal string OperatorConnectionString => server.Operator(Name);

    internal string SuperuserConnectionString => server.Superuser(Name);

    /// <summary>A runtime-role pool; disposed with the database.</summary>
    internal PgDatabase OpenApp(string? connectionString = null)
    {
        var database = new PgDatabase(connectionString ?? AppConnectionString, "foxwarm-test");
        opened.Add(database);
        return database;
    }

    internal PgDatabase OpenOwner()
    {
        var database = new PgDatabase(OwnerConnectionString, "foxwarm-test-owner");
        opened.Add(database);
        return database;
    }

    internal async Task<int> TenantIdAsync(string tenant = PostgresServer.Tenant) =>
        (int)(await ScalarAsync("SELECT tenant_id FROM tenants WHERE name = $1", tenant))!;

    // Low-level lease tests stand in for registered replica processes. Preserve a row
    // explicitly installed by a test (including tests simulating an older binary).
    internal async Task RegisterBootsAsync(params string[] replicas)
    {
        await using var connection=new NpgsqlConnection(OwnerConnectionString);
        await connection.OpenAsync();
        await using var command=new NpgsqlCommand("INSERT INTO replicas(replica_id,binary_level,reader_version) SELECT id,$2,2 FROM unnest($1::text[]) id ON CONFLICT DO NOTHING",connection);
        command.Parameters.Add(PgTx.Parameter(replicas));
        command.Parameters.Add(PgTx.Parameter(SchemaMigrator.BinaryLevel));
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Takes the tenant lease the way a takeover does: waits for writers of the current epoch
    /// (FOR UPDATE), then raises the epoch. Returns the new epoch.
    /// </summary>
    internal async Task<long> TakeLeaseAsync(
        int tenantId,
        string owner = "test",
        TimeSpan? ttl = null
    )
    {
        await RegisterBootsAsync(owner);
        await using var connection = new NpgsqlConnection(OwnerConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var locking = new NpgsqlCommand(
            "SELECT epoch FROM tenant_leases WHERE tenant_id = $1 FOR UPDATE",
            connection,
            transaction
        ))
        {
            locking.Parameters.Add(new NpgsqlParameter<int> { TypedValue = tenantId });
            await locking.ExecuteScalarAsync();
        }
        await using var update = new NpgsqlCommand(
            "UPDATE tenant_leases SET owner_replica = $2, epoch = epoch + 1, state = 'active',"
                + " acquired_at = now(), expires_at = now() + make_interval(secs => $3)"
                + " WHERE tenant_id = $1 RETURNING epoch",
            connection,
            transaction
        );
        update.Parameters.Add(new NpgsqlParameter<int> { TypedValue = tenantId });
        update.Parameters.Add(new NpgsqlParameter<string> { TypedValue = owner });
        update.Parameters.Add(new NpgsqlParameter<double> { TypedValue = (ttl ?? TimeSpan.FromHours(1)).TotalSeconds });
        var epoch = (long)(await update.ExecuteScalarAsync())!;
        await transaction.CommitAsync();
        return epoch;
    }

    /// <summary>Runs as the superuser, which row-level security doesn't restrict.</summary>
    internal async Task<object?> ScalarAsync(string sql, params object?[] parameters)
    {
        await using var connection = new NpgsqlConnection(SuperuserConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var value in parameters)
            command.Parameters.Add(PgTx.Parameter(value));
        var result = await command.ExecuteScalarAsync();
        return result is DBNull ? null : result;
    }

    internal async Task ExecuteOwnerAsync(string sql)
    {
        await using var connection = new NpgsqlConnection(OwnerConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Creates a test-only tenant table through the same helper migrations use, with the
    /// runtime role's privileges.
    /// </summary>
    internal Task CreateTenantTableAsync(string name) =>
        ExecuteOwnerAsync(
            $"SELECT set_config('foxwarm.app_role', '{PostgresServer.AppRole}', false);"
                + $" CREATE TABLE {name} (tenant_id integer NOT NULL, key text COLLATE \"C\" NOT NULL,"
                + " value text COLLATE \"C\", PRIMARY KEY (tenant_id, key));"
                + $" SELECT foxwarm_tenant_table('{name}', 'SELECT, INSERT, UPDATE, DELETE')"
        );

    public async ValueTask DisposeAsync()
    {
        foreach (var database in opened)
            await database.DisposeAsync();
        await PostgresServer.ExecuteAsync(
            server.Superuser("postgres"),
            $"DROP DATABASE IF EXISTS {Name} WITH (FORCE)"
        );
    }
}
