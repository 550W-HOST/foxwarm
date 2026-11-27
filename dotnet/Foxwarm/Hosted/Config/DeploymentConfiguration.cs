using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

/// <summary>
/// The operator's deployment configuration: a YAML file mounted into every replica
/// (<c>FOXWARM_DEPLOYMENT_CONFIG</c>) and read once at process start; a change takes effect
/// through a rolling restart. It holds only the deployment paths of
/// <see cref="AppConfigurationSplit"/>, in the app configuration's shape: the public listener is
/// <c>bot.httpHost</c> and <c>bot.httpPort</c> with file mode's rules and default, and the health
/// listener port is <c>health.port</c>, which is required. The blob backend is <c>blobs</c>
/// (<see cref="BlobSettings"/>), also required. <c>egress</c> holds the egress guard's
/// deployment rules (<see cref="Foxwarm.Net.EgressRules"/>).
/// </summary>
internal sealed record DeploymentConfiguration(
    JsonObject Root,
    IPEndPoint PublicEndpoint,
    int HealthPort,
    BlobSettings Blobs,
    Foxwarm.Net.EgressRules Egress
)
{
    internal const string Variable = "FOXWARM_DEPLOYMENT_CONFIG";

    /// <summary>The placeholder of a <c>url</c> template: one tenant's slug.</summary>
    internal const string SlugPlaceholder = "{slug}";

    /// <summary>The health listener on the public listener's address.</summary>
    internal IPEndPoint HealthEndpoint => new(PublicEndpoint.Address, HealthPort);

    /// <summary>Whether <c>url</c> is a template with <see cref="SlugPlaceholder"/>.</summary>
    internal bool UrlIsTemplate =>
        SessionWait.Text(Root["url"]) is { } url && url.Contains(SlugPlaceholder, StringComparison.Ordinal);

    /// <summary>
    /// The configuration one tenant's runtime reads: a <c>url</c> template expanded with the
    /// tenant's slug, so the host, Node routes and model configuration see one concrete origin.
    /// A literal <c>url</c> (single-tenant replicas) is returned unchanged.
    /// </summary>
    internal DeploymentConfiguration ForTenant(string slug)
    {
        if (!UrlIsTemplate)
            return this;
        var root = Root.DeepClone().AsObject();
        root["url"] = Expand(SessionWait.Text(Root["url"])!, slug);
        return this with { Root = root };
    }

    /// <summary>The tenant's public origin: the expanded <c>url</c>, or the front's port under the slug.</summary>
    internal string TenantOrigin(string slug) =>
        SessionWait.Text(ForTenant(slug).Root["url"])?.TrimEnd('/') ?? $"http://{slug}:{PublicEndpoint.Port}";

    // The front knows the mount before it knows the tenant. Preserve a slug placeholder in
    // the mount itself: on a custom hostname it cannot infer the slug from the Host header.
    internal System.Text.RegularExpressions.Regex? MountedOperatorPath()
    {
        if (SessionWait.Text(Root["url"]) is not { } url) return null;
        var slash = url.IndexOf('/', url.IndexOf("://", StringComparison.Ordinal) + 3);
        if (slash < 0) return null;
        var template = PublicWebAddress.Capture(PublicEndpoint.Port, "http://localhost" + url[slash..]).Prefix.Value;
        if (string.IsNullOrEmpty(template)) return null;
        var parts = template.Split(SlugPlaceholder, StringSplitOptions.None);
        var pattern = new System.Text.StringBuilder("^" + System.Text.RegularExpressions.Regex.Escape(parts[0]));
        for (var i=1;i<parts.Length;i++)
            pattern.Append(i==1 ? @"(?<slug>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)" : @"\k<slug>")
                .Append(System.Text.RegularExpressions.Regex.Escape(parts[i]));
        pattern.Append("(?i:" + System.Text.RegularExpressions.Regex.Escape(Operator.OperatorServer.Path) + ")(?:/|$)");
        return new(pattern.ToString(), System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    private static string Expand(string template, string slug) =>
        template.Replace(SlugPlaceholder, slug, StringComparison.Ordinal);

    internal static DeploymentConfiguration Load(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path, new UTF8Encoding(false, true));
        }
        catch (Exception error)
            when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            throw new HostedBootstrapException($"{Variable} can't be read: {error.Message}");
        }
        return Parse(text);
    }

    internal static DeploymentConfiguration Parse(string text)
    {
        try
        {
            var root = ConfigurationYaml.Parse(text.TrimStart('\uFEFF'), "deployment configuration");
            AppConfigurationSplit.RequireDeploymentDocument(root);
            // A template is valid when its expansion is: the placeholder stands for a DNS label.
            var validated = root;
            if (SessionWait.Text(root["url"]) is { } url && url.Contains(SlugPlaceholder, StringComparison.Ordinal))
            {
                validated = root.DeepClone().AsObject();
                validated["url"] = Expand(url, "tenant");
            }
            AppConfigurationRules.Validate(validated);
            var address = IPAddress.Parse(HttpServerSettings.ListenAddress(root["bot"]?["httpHost"]));
            var port = HttpServerSettings.ListenPort(root["bot"]?["httpPort"]);
            return new(
                root,
                new IPEndPoint(address, port),
                RequiredHealthPort(root),
                BlobSettings.Parse(root["blobs"]),
                Foxwarm.Net.EgressRules.Parse(root["egress"])
            );
        }
        catch (InvalidDataException error)
        {
            throw new HostedBootstrapException("Deployment configuration: " + error.Message);
        }
    }

    private static int RequiredHealthPort(JsonObject root)
    {
        if (root["health"] is not JsonObject health)
            throw new InvalidDataException("`health.port` is required.");
        foreach (var (key, _) in health)
            if (key != "port")
                throw new InvalidDataException($"`health.{key}` isn't a setting.");
        return SessionWait.Number(health["port"]) is { } port
            && port is >= 1 and <= 65535
            && port == Math.Truncate(port)
            ? (int)port
            : throw new InvalidDataException("`health.port` must be a port number.");
    }
}
