using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeBootstrap
{
    private static readonly string[] LaunchMethods =
    [
        "bareMetal",
        "bareMetalBackground",
        "bareMetalInstall",
        "interactive",
        "windows",
        "docker",
        "shell",
        "windowsShell",
    ];

    // These facts are command suggestions, never Main execution paths or authority.
    internal static JsonObject? LaunchInfo(JsonNode? value)
    {
        if (
            value is not JsonObject input
            || !LaunchMethods.Contains(SessionWait.Text(input["method"]))
        )
            return null;
        var result = new JsonObject();
        foreach (
            var key in new[]
            {
                "method", "platform", "installDir", "stateDir", "sourceDir",
                "composeFile", "envFile", "mode", "serviceScope",
            }
        )
            if (
                SessionWait.Text(input[key]) is { Length: > 0 and <= 4096 } text
                && !text.Any(c => c is '\0' or '\r' or '\n')
            )
                result[key] = text;
        return result;
    }

    internal JsonObject ExistingLaunch(JsonObject record, JsonObject body)
    {
        var launch = LaunchInfo(record["launchInfo"]) ?? new JsonObject
        {
            ["method"] = SessionWait.Text(record["nodeType"]) == "shell-node" ? "shell" : "bareMetal",
        };
        foreach (
            var key in new[]
            {
                "method", "installDir", "stateDir", "sourceDir",
                "composeFile", "envFile", "mode", "serviceScope",
            }
        )
        {
            if (!body.ContainsKey(key))
                continue;
            var text = SessionWait.Text(body[key]);
            if (
                text is null
                || text.Length > 4096
                || text.Any(c => c is '\0' or '\r' or '\n')
            )
                throw new InvalidDataException("Enter a valid " + key + ".");
            if (key == "installDir" && string.IsNullOrWhiteSpace(text))
                throw new InvalidDataException("Enter an installation directory.");
            if (text.Length == 0)
                launch.Remove(key);
            else
                launch[key] = text;
        }
        if (!LaunchMethods.Contains(SessionWait.Text(launch["method"])))
            throw new InvalidDataException("Choose a launch method.");
        launch["installDir"] ??= SessionWait.Text(launch["method"]) == "windows"
            ? @"C:\foxwarm-node"
            : "/opt/foxwarm-node";
        return launch;
    }

    internal JsonObject ExistingCommand(
        string url,
        string id,
        JsonObject launch,
        string? auth = null
    )
    {
        var method = launch["method"]!.GetValue<string>();
        var shell = method is "shell" or "windowsShell";
        var result = new JsonObject
        {
            ["baseUrl"] = NormalizeBaseUrl(url),
            ["launchInfo"] = launch.DeepClone(),
            ["requiresToken"] = shell,
        };
        if (shell && auth is null)
            return result;
        var directory = launch["installDir"]!.GetValue<string>();
        var commands = Commands(
            url, id, directory, auth, storedCredentials: auth is null, launch: launch
        );
        var command = commands["commands"]![method]!.GetValue<string>();
        if (auth is null && method == "docker")
            command = "cd " + Quote(directory) + " && docker compose"
                + " --env-file " + Quote(SessionWait.Text(launch["envFile"]) ?? ".env")
                + " -f " + Quote(SessionWait.Text(launch["composeFile"]) ?? "docker-compose.yaml")
                + " up -d";
        if (auth is null && method == "bareMetalInstall")
        {
            var serviceId = id.Trim('-');
            if (serviceId.Length == 0)
                serviceId = "node";
            command = "systemctl "
                + (SessionWait.Text(launch["serviceScope"]) == "system" ? "" : "--user ")
                + "restart " + Quote("foxwarm-node-" + serviceId + ".service");
        }
        result["command"] = command;
        return result;
    }
}
