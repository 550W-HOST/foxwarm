using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Net;

namespace Foxwarm.Hosted.Operator;

internal static class OperatorCli
{
    internal const string Usage = """
        Usage: foxwarm operator serve
               foxwarm operator token create
               foxwarm operator --url ORIGIN --token-file FILE COMMAND
        Commands:
          tenants | placement | deletions
          tenant create SLUG PROFILE HOSTNAME | tenant get SLUG | tenant rotate SLUG | tenant set SLUG JSON-FILE
          tenant suspend SLUG | tenant resume SLUG | tenant delete SLUG
          ceiling get PROFILE | ceiling set PROFILE JSON-FILE
        """;

    internal static async Task<int> RunAsync(string[] args, TextWriter output, TextWriter error, CancellationToken token = default)
    {
        try
        {
            if (args is ["operator", "serve"])
            {
                await OperatorServer.ServeAsync(HostedBootstrap.FromEnvironment(), token);
                return 0;
            }
            if (args is ["operator", "token", "create"])
            {
                var settings = HostedBootstrap.FromEnvironment();
                await using var owner = new PgDatabase(settings.MigrateDatabaseUrl ?? throw new HostedBootstrapException("Set FOXWARM_MIGRATE_DATABASE_URL or FOXWARM_MIGRATE_DATABASE_URL_FILE."), "foxwarm-operator-token");
                await SchemaMigrator.RequireCompatibleAsync(owner, token: token);
                await output.WriteLineAsync(await OperatorStore.IssueAsync(owner, token));
                return 0;
            }
            if (args is not ["operator", "--url", var url, "--token-file", var credential, ..var command])
                throw new ArgumentException(Usage);
            if (!Uri.TryCreate(url, UriKind.Absolute, out var origin) || origin.Scheme is not ("https" or "http")
                || origin.AbsolutePath != "/" || origin.Query.Length > 0 || origin.UserInfo.Length > 0 || origin.Fragment.Length > 0)
                throw new ArgumentException("--url must be the operator's HTTP or HTTPS origin.");
            var (method, path, body) = await RequestAsync(command, token);
            using var client = EgressHttp.Client(EgressPolicy.Unguarded, EgressPurpose.Deployment,
                new EgressHandlerOptions { UseCookies = false, AllowAutoRedirect = false });
            using var request = new HttpRequestMessage(method, new Uri(origin, OperatorServer.Path + path));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", (await File.ReadAllTextAsync(credential, token)).Trim());
            if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request, token);
            await (response.IsSuccessStatusCode ? output : error).WriteLineAsync(await response.Content.ReadAsStringAsync(token));
            return response.IsSuccessStatusCode ? 0 : 1;
        }
        catch (Exception failure) when (failure is ArgumentException or HostedBootstrapException or SchemaIncompatibleException or IOException or HttpRequestException or Npgsql.NpgsqlException or UnauthorizedAccessException)
        {
            await error.WriteLineAsync(failure is Npgsql.NpgsqlException ? "Operator database operation failed." : failure.Message);
            return failure is ArgumentException ? 2 : failure is HostedBootstrapException or SchemaIncompatibleException ? 78 : 1;
        }
    }

    private static async Task<(HttpMethod, string, string?)> RequestAsync(string[] args, CancellationToken token)
    {
        static string Tenant(string slug) => TenantSlugs.IsValid(slug) ? "/tenants/" + slug : throw new ArgumentException("Tenant slug must be " + TenantSlugs.Rule + ".");
        static string Ceiling(string profile) => profile is "hosted" or "operator" ? "/profiles/" + profile + "/ceiling" : throw new ArgumentException("The profile must be hosted or operator.");
        return args switch
        {
            ["tenants"] => (HttpMethod.Get, "/tenants", null),
            ["tenant", "get", var slug] => (HttpMethod.Get, Tenant(slug), null),
            ["tenant", "create", var slug, var profile, var hostname] => (HttpMethod.Post, "/tenants", new JsonObject { ["slug"] = slug, ["profile"] = profile, ["primaryHostname"] = hostname }.ToJsonString()),
            ["tenant", "set", var slug, var file] => (HttpMethod.Patch, Tenant(slug), await File.ReadAllTextAsync(file, token)),
            ["tenant", "rotate", var slug] => (HttpMethod.Post, Tenant(slug) + "/rotate", null),
            ["tenant", "suspend", var slug] => (HttpMethod.Post, Tenant(slug) + "/suspend", null),
            ["tenant", "resume", var slug] => (HttpMethod.Post, Tenant(slug) + "/resume", null),
            ["tenant", "delete", var slug] => (HttpMethod.Delete, Tenant(slug), null),
            ["deletions"] => (HttpMethod.Get, "/deletions", null),
            ["placement"] => (HttpMethod.Get, "/placement", null),
            ["ceiling", "get", var profile] => (HttpMethod.Get, Ceiling(profile), null),
            ["ceiling", "set", var profile, var file] => (HttpMethod.Put, Ceiling(profile), await File.ReadAllTextAsync(file, token)),
            _ => throw new ArgumentException(Usage),
        };
    }
}
