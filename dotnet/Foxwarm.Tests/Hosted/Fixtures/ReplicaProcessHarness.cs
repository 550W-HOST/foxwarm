using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Multi-tenant replicas as real processes (<c>dotnet Foxwarm.dll</c> in hosted mode) over one migrated test database. Each replica reaches
/// the database through its own <see cref="PgTcpProxy"/>, so a test can partition one replica
/// alone, and has its own front, health port, scratch and Agents directories and heap limit.
/// The processes exit for real: <see cref="Replica.Kill"/> is SIGKILL, <see cref="Replica.Terminate"/>
/// SIGTERM, and a fence ends the process with its own exit code.
/// <list type="bullet">
/// <item><see cref="AddTenantAsync"/> creates a tenant with its lease row and hostname <c>&lt;slug&gt;.test</c>.</item>
/// <item><see cref="StartAsync"/> starts a replica and waits until its health endpoint is ready.</item>
/// <item><see cref="Replica.GetAsync"/> sends a request through that replica's front with the tenant's host.</item>
/// <item><see cref="Replica.StatusAsync"/> reads its <c>/status</c>; <see cref="OwnerAsync"/> and <see cref="EpochAsync"/> read the lease row.</item>
/// </list>
/// </summary>
internal sealed class ReplicaProcessHarness : IAsyncDisposable
{
    private readonly TempDirectory temp = new();
    private readonly List<Replica> replicas = [];
    private readonly string kek;
    private readonly string meshKey;

    private ReplicaProcessHarness(HostedTestDatabase database)
    {
        Database = database;
        kek = Path.Combine(temp.Path, "kek", "current.key");
        InstanceKeys.OpenOrCreate(kek);
        meshKey = Path.Combine(temp.Path, "mesh.key");
        File.WriteAllText(meshKey, Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)));
    }

    internal HostedTestDatabase Database { get; }

    internal static async Task<ReplicaProcessHarness> CreateAsync()
    {
        var server = await PostgresServer.SharedAsync();
        return new ReplicaProcessHarness(await server.CreateDatabaseAsync());
    }

    internal async Task AddTenantAsync(string slug)
    {
        if (slug != PostgresServer.Tenant)
            await Database.ExecuteOwnerAsync(
                $"INSERT INTO tenants (name) VALUES ('{slug}');"
                    + $" INSERT INTO tenant_leases (tenant_id) SELECT tenant_id FROM tenants WHERE name = '{slug}'"
            );
        await Database.ExecuteOwnerAsync(
            $"INSERT INTO tenant_hostnames (hostname, tenant_id, kind) SELECT '{slug}.test', tenant_id, 'primary' FROM tenants WHERE name = '{slug}'"
        );
    }

    /// <summary>The active owner of the tenant's lease (the per-boot replica ID), or null.</summary>
    internal async Task<string?> OwnerAsync(string slug) =>
        await Database.ScalarAsync(
            "SELECT CASE WHEN l.state = 'active' AND l.expires_at > now() THEN l.owner_replica END"
                + " FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1",
            slug
        ) as string;

    /// <summary>The tenant's lease row as stored, with the database's clock.</summary>
    internal async Task<LeaseRow> LeaseRowAsync(string slug)
    {
        await using var connection = new Npgsql.NpgsqlConnection(Database.OwnerConnectionString);
        await connection.OpenAsync();
        await using var command = new Npgsql.NpgsqlCommand(
            "SELECT l.state, l.owner_replica, l.epoch, l.acquired_at, l.expires_at, clock_timestamp()"
                + " FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1",
            connection
        );
        command.Parameters.Add(new Npgsql.NpgsqlParameter<string> { TypedValue = slug });
        await using var reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        return new(
            reader.GetString(0),
            reader.IsDBNull(1) ? null : reader.GetString(1),
            reader.GetInt64(2),
            reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3),
            reader.GetFieldValue<DateTimeOffset>(4),
            reader.GetFieldValue<DateTimeOffset>(5)
        );
    }

    internal sealed record LeaseRow(
        string State,
        string? Owner,
        long Epoch,
        DateTimeOffset? AcquiredAt,
        DateTimeOffset ExpiresAt,
        DateTimeOffset Now
    );

    internal async Task<long> EpochAsync(string slug) =>
        (long)(await Database.ScalarAsync(
            "SELECT l.epoch FROM tenant_leases l JOIN tenants t USING (tenant_id) WHERE t.name = $1",
            slug
        ))!;

    internal async Task<string> SignInTokenAsync(string slug)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();
        var code = await Foxwarm.Hosted.HostedCli.RunAsync(["hosted", "token", "--tenant", slug], output, error,
            new System.Collections.Hashtable { ["FOXWARM_DATABASE_URL"] = Database.AppConnectionString, ["FOXWARM_KEK_FILE"] = kek });
        Assert.True(code == 0, error.ToString());
        return output.ToString().Trim();
    }

    /// <summary>Starts a replica process named <paramref name="name"/> and waits until it is ready.</summary>
    internal async Task<Replica> StartAsync(string name, IDictionary<string, string>? environment = null, bool webUi = true,
        string extraConfig = "", Func<int>? samplePort = null)
    {
        samplePort ??= ChildListenerPorts.Sample;
        for (int attempt = 1; ; attempt++)
        {
            HashSet<int> ports = [];
            int NextPort()
            {
                int port;
                do port = samplePort(); while (!ports.Add(port));
                return port;
            }
            var front = NextPort();
            var health = NextPort();
            var mesh = NextPort();
            var replica = await LaunchAsync(name, front, health, mesh, environment, webUi, extraConfig);
            try
            {
                await replica.ReadyAsync(TimeSpan.FromSeconds(60), Database, mesh);
                lock (replicas) replicas.Add(replica);
                return replica;
            }
            catch (IOException error) when (attempt < ChildListenerPorts.MaxAttempts && replica.Exited && ChildListenerPorts.IsCollision(error.Message))
            {
                await replica.DisposeAsync();
                // A public bind failure can follow registration. This unpublished test boot will
                // never heartbeat again; remove its exact registration before retrying that name.
                if (error.Message.Contains($"127.0.0.1:{front}", StringComparison.Ordinal))
                    await Database.ScalarAsync("DELETE FROM replicas WHERE mesh_address=$1 AND split_part(replica_id,'/',1)=$2", $"http://127.0.0.1:{mesh}", replica.Name);
            }
            catch
            {
                await replica.DisposeAsync();
                throw;
            }
        }
    }

    private async Task<Replica> LaunchAsync(string name, int front, int health, int mesh, IDictionary<string,string>? environment, bool webUi, string extraConfig)
    {
        var root = Path.Combine(temp.Path, name);
        Directory.CreateDirectory(root);
        var deployment = Path.Combine(root, "deployment.yaml");
        await File.WriteAllTextAsync(
            deployment,
            $"bot: {{httpHost: 127.0.0.1, httpPort: {front}, enableWebUI: {webUi.ToString().ToLowerInvariant()}}}\nhealth: {{port: {health}}}\nmesh: {{port: {mesh}}}\nblobs: {{backend: postgres}}\n{extraConfig}"
        );
        var proxy = PgTcpProxy.For(Database.AppConnectionString);
        var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
        var native = Environment.GetEnvironmentVariable("FOXWARM_TEST_MAIN_EXECUTABLE");
        var info = new ProcessStartInfo(native ?? (dotnetRoot is null ? "dotnet" : Path.Combine(dotnetRoot, "dotnet")))
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = root,
        };
        if (native is null)
            info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "Foxwarm.dll"));
        // Owned paths only; nothing of a real installation or of the test process's own state.
        foreach (var key in info.Environment.Keys.Where(key => key.StartsWith("FOXWARM_", StringComparison.Ordinal)).ToArray())
            info.Environment.Remove(key);
        info.Environment["FOXWARM_MODE"] = "hosted";
        info.Environment["FOXWARM_DATABASE_URL"] = proxy.Route(Database.AppConnectionString);
        info.Environment["FOXWARM_APP_ROLE"] = PostgresServer.AppRole;
        info.Environment["FOXWARM_OPERATOR_ROLE"] = PostgresServer.OperatorRole;
        info.Environment["FOXWARM_REPLICA_ID"] = name;
        info.Environment["FOXWARM_SCRATCH_DIR"] = Path.Combine(root, "scratch");
        info.Environment["FOXWARM_AGENTS_DIR"] = Path.Combine(root, "agents");
        info.Environment["FOXWARM_KEK_FILE"] = kek;
        info.Environment["FOXWARM_ADVERTISE_ADDRESS"] = $"127.0.0.1:{mesh}";
        info.Environment["FOXWARM_MESH_SECRET_FILE"] = meshKey;
        info.Environment["FOXWARM_DEPLOYMENT_CONFIG"] = deployment;
        info.Environment["HOME"] = Path.Combine(root, "home");
        info.Environment["TMPDIR"] = Path.Combine(root, "tmp");
        Directory.CreateDirectory(Path.Combine(root, "home"));
        Directory.CreateDirectory(Path.Combine(root, "tmp"));
        // A replica-sized heap, so a runaway shows as the process's own failure.
        info.Environment["DOTNET_GCHeapHardLimit"] = "0x30000000";
        foreach (var (key, value) in environment ?? new Dictionary<string, string>())
            info.Environment[key] = value;
        if (info.Environment.TryGetValue("FOXWARM_ROLE", out var role) && role == "master-host")
            Directory.CreateDirectory(info.Environment["FOXWARM_AGENTS_DIR"]!);
        var process = Process.Start(info)!;
        return new Replica(info.Environment["FOXWARM_REPLICA_ID"]!, process, proxy, front, health);
    }

    public async ValueTask DisposeAsync()
    {
        Replica[] all;
        lock (replicas)
            all = [.. replicas];
        foreach (var replica in all)
            await replica.DisposeAsync();
        await Database.DisposeAsync();
        temp.Dispose();
    }

    /// <summary>One replica process.</summary>
    internal sealed class Replica : IAsyncDisposable
    {
        private readonly Process process;
        private readonly StringBuilder output = new();
        private readonly Task reading;
        private readonly HttpClient client = new(new HttpClientHandler { UseProxy = false, UseCookies = false, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(40),
        };

        internal Replica(string name, Process process, PgTcpProxy proxy, int frontPort, int healthPort)
        {
            Name = name;
            this.process = process;
            Proxy = proxy;
            FrontPort = frontPort;
            HealthPort = healthPort;
            reading = Task.WhenAll(CopyAsync(process.StandardOutput), CopyAsync(process.StandardError));
        }

        internal string Name { get; }

        /// <summary>This replica's own path to the database: partition and heal it here.</summary>
        internal PgTcpProxy Proxy { get; }

        internal int FrontPort { get; }

        internal int HealthPort { get; }

        internal bool Exited => process.HasExited;

        /// <summary>Everything the process wrote to stdout and stderr so far.</summary>
        internal string Output
        {
            get
            {
                lock (output)
                    return output.ToString();
            }
        }

        private async Task CopyAsync(StreamReader reader)
        {
            while (await reader.ReadLineAsync() is { } line)
                lock (output)
                    output.AppendLine(line);
        }

        internal async Task ReadyAsync(TimeSpan limit, HostedTestDatabase database, int mesh)
        {
            var watch = Stopwatch.StartNew();
            while (true)
            {
                if (process.HasExited)
                {
                    await reading;
                    throw new IOException($"Replica {Name} exited with {process.ExitCode}:\n{Output}");
                }
                try
                {
                    using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                    var status = await StatusAsync(bound.Token);
                    if (status["ready"] is JsonValue ready && ready.TryGetValue<bool>(out var serving) && serving
                        && status["replica"] is JsonValue id && id.TryGetValue<string>(out var boot)
                        && Foxwarm.Hosted.Lease.ReplicaRegistry.LogicalName(boot) == Name
                        && await database.ScalarAsync("SELECT mesh_address FROM replicas WHERE replica_id=$1", boot) as string == $"http://127.0.0.1:{mesh}")
                        return;
                }
                catch (HttpRequestException) { }
                catch (OperationCanceledException) { } // A different process may accept TCP without answering.
                catch (System.Text.Json.JsonException) { } // Another listener may occupy the sampled health port.
                Assert.True(watch.Elapsed < limit, $"replica {Name} didn't become ready:\n{Output}");
                await Task.Delay(100);
            }
        }

        internal async Task<JsonObject> StatusAsync(CancellationToken token = default) =>
            JsonNode.Parse(await client.GetStringAsync($"http://127.0.0.1:{HealthPort}/status", token))!.AsObject();

        /// <summary>A request through this replica's front, as for the tenant's host.</summary>
        internal async Task<HttpResponseMessage> GetAsync(
            string tenant,
            string path = "/api/sessions",
            CancellationToken token = default
        )
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{FrontPort}{path}");
            request.Headers.Host = tenant + ".test";
            return await client.SendAsync(request, token);
        }

        /// <summary>SIGKILL: no stop of any kind, its grants stay until they expire.</summary>
        internal void Kill() => process.Kill(entireProcessTree: true);

        /// <summary>SIGTERM: the replica's graceful stop.</summary>
        internal void Terminate() => Assert.Equal(0, SendSignal(process.Id, 15));

        internal async Task<int> ExitAsync(TimeSpan limit)
        {
            await process.WaitForExitAsync().WaitAsync(limit);
            await reading.WaitAsync(TimeSpan.FromSeconds(5));
            return process.ExitCode;
        }

        [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
        private static extern int SendSignal(int pid, int signal);

        public async ValueTask DisposeAsync()
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            try
            {
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
            catch { }
            process.Dispose();
            client.Dispose();
            await Proxy.DisposeAsync();
        }
    }
}
