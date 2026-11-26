using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted;

/// <summary>
/// The operator's deployment configuration: a YAML file mounted into every replica
/// (<c>FOXWARM_DEPLOYMENT_CONFIG</c>) and read once at process start; a change takes effect
/// through a rolling restart. It holds only the deployment paths of
/// <see cref="AppConfigurationSplit"/>, in the app configuration's shape: the public listener is
/// <c>bot.httpHost</c> and <c>bot.httpPort</c> with file mode's rules and default, and the health
/// listener port is <c>health.port</c>, which is required.
/// </summary>
internal sealed record DeploymentConfiguration(JsonObject Root, IPEndPoint PublicEndpoint, int HealthPort)
{
    internal const string Variable = "FOXWARM_DEPLOYMENT_CONFIG";

    /// <summary>The health listener on the public listener's address.</summary>
    internal IPEndPoint HealthEndpoint => new(PublicEndpoint.Address, HealthPort);

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
            AppConfigurationRules.Validate(root);
            var address = IPAddress.Parse(HttpServerSettings.ListenAddress(root["bot"]?["httpHost"]));
            var port = HttpServerSettings.ListenPort(root["bot"]?["httpPort"]);
            return new(root, new IPEndPoint(address, port), RequiredHealthPort(root));
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
