using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The PostgreSQL connection pool of one hosted process. Only the transaction helper, the
/// tenant lease and the schema migrator open connections from it; store code receives a
/// <see cref="TenantDb"/> and never sees a connection.
/// </summary>
internal sealed class PgDatabase : IAsyncDisposable
{
    private readonly NpgsqlDataSource source;

    internal PgDatabase(string connectionString, string applicationName)
    {
        var settings = new NpgsqlConnectionStringBuilder(PgConnectionString.Normalize(connectionString))
        {
            ApplicationName = applicationName,
        };
        var builder = new NpgsqlSlimDataSourceBuilder(settings.ConnectionString);
        builder.EnableTransportSecurity();
        builder.EnableArrays();
        source = builder.Build();
        Database = settings.Database ?? "";
    }

    /// <summary>The database name, for diagnostics.</summary>
    internal string Database { get; }

    internal NpgsqlConnection Open() => source.OpenConnection();

    internal ValueTask<NpgsqlConnection> OpenAsync(CancellationToken token) =>
        source.OpenConnectionAsync(token);

    public ValueTask DisposeAsync() => source.DisposeAsync();
}

/// <summary>
/// Accepts either Npgsql keyword syntax (<c>Host=…;Database=…</c>) or a
/// <c>postgres://user:password@host:port/database?sslmode=…</c> URL and returns keyword syntax.
/// </summary>
internal static class PgConnectionString
{
    internal static string Normalize(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        var text = value.Trim();
        if (
            !text.StartsWith("postgres://", StringComparison.Ordinal)
            && !text.StartsWith("postgresql://", StringComparison.Ordinal)
        )
            return text;
        // libpq URI form: scheme://[user[:password]@][host[:port][,…]][/database][?key=value&…].
        // System.Uri rejects forms libpq accepts (an empty host with ?host=/socket/dir).
        var rest = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..];
        var query = "";
        var mark = rest.IndexOf('?');
        if (mark >= 0)
        {
            query = rest[(mark + 1)..];
            rest = rest[..mark];
        }
        var database = "";
        var slash = rest.IndexOf('/');
        if (slash >= 0)
        {
            database = rest[(slash + 1)..];
            rest = rest[..slash];
        }
        var builder = new NpgsqlConnectionStringBuilder();
        var at = rest.LastIndexOf('@');
        if (at >= 0)
        {
            var userInfo = rest[..at];
            rest = rest[(at + 1)..];
            var separator = userInfo.IndexOf(':');
            builder.Username = Uri.UnescapeDataString(
                separator < 0 ? userInfo : userInfo[..separator]
            );
            if (separator >= 0)
                builder.Password = Uri.UnescapeDataString(userInfo[(separator + 1)..]);
        }
        if (rest.Length > 0)
        {
            var hosts = Uri.UnescapeDataString(rest);
            var colon = hosts.LastIndexOf(':');
            if (!hosts.Contains(',') && !hosts.Contains(']') && colon > 0 && hosts.IndexOf(':') == colon)
            {
                builder.Host = hosts[..colon];
                builder.Port = int.Parse(hosts[(colon + 1)..], System.Globalization.CultureInfo.InvariantCulture);
            }
            else
                builder.Host = hosts;
        }
        if (database.Length > 0)
            builder.Database = Uri.UnescapeDataString(database);
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = pair.IndexOf('=');
            var key = Uri.UnescapeDataString(equals < 0 ? pair : pair[..equals]);
            var setting = equals < 0 ? "" : Uri.UnescapeDataString(pair[(equals + 1)..]);
            builder[key switch
            {
                "sslmode" => "SSL Mode",
                "host" => "Host",
                "port" => "Port",
                "user" => "Username",
                "password" => "Password",
                "dbname" => "Database",
                "application_name" => "Application Name",
                "connect_timeout" => "Timeout",
                _ => key,
            }] = setting;
        }
        return builder.ConnectionString;
    }
}
