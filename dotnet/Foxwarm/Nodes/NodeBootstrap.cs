using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json.Nodes;

namespace Foxwarm.Nodes;

internal sealed class NodeBootstrap(NodeConnectionHub hub, PublicWebAddress address)
{
    private static readonly string[] Templates =
    [
        "run-shell.sh",
        "run.sh",
        "run-docker.sh",
        "run-interactive.sh",
        "run.ps1",
        "docker-compose.yaml",
    ];
    private static readonly string[] Sources =
    [
        "packages/shared",
        "packages/cli-node",
        "packages/cli-node-runtime",
    ];

    internal static bool IsPublicPath(PathString path) =>
        path == "/node/source.tar.gz"
        || Templates.Any(name => path == "/node/" + name)
        || path == "/node/run-cli-node.sh";

    private static string Quote(string value) => "'" + value.Replace("'", "'\"'\"'") + "'";

    internal JsonObject Commands(
        string? baseUrl = null,
        string? id = null,
        string directory = "/opt/foxwarm-node"
    )
    {
        var url = NormalizeBaseUrl(baseUrl ?? address.BaseUrl);
        var shellId = id ?? "my-shell";
        id ??= "my-node";
        ApprovedNodeRegistry.ValidateId(id);
        if (directory.Length == 0 || directory.Any(c => c is '\0' or '\r' or '\n'))
            throw new InvalidDataException("Enter an installation directory.");
        string Download(string name) =>
            "curl -fsSL " + Quote(url + "/node/" + name) + " | bash -s --";
        var arguments =
            " --host="
            + Quote(url)
            + " --pairing="
            + Quote(hub.Registry.PairingToken)
            + " --node-id="
            + Quote(id);
        return new JsonObject
        {
            ["baseUrl"] = url,
            ["commands"] = new JsonObject
            {
                ["shell"] = ShellCommand(url, shellId, "YOUR_PER_NODE_AUTH_TOKEN"),
                ["bareMetal"] = Download("run.sh") + " --dir=" + Quote(directory) + arguments,
                ["bareMetalBackground"] =
                    Download("run.sh") + " --dir=" + Quote(directory) + arguments + " -d",
                ["bareMetalInstall"] =
                    Download("run.sh") + " --dir=" + Quote(directory) + arguments + " --install",
                ["docker"] = Download("run-docker.sh") + arguments,
                ["interactive"] = Download("run-interactive.sh") + arguments,
                ["manualCompose"] =
                    "curl -fsSL "
                    + Quote(url + "/node/docker-compose.yaml")
                    + " -o docker-compose.yaml\numask 077\ncat > .env <<'FOXWARM_NODE_ENV'\n"
                    + "NODE_HOST='"
                    + url.Replace("'", "\\'")
                    + "'\n"
                    + "NODE_SOURCE_URL='"
                    + (url + "/node/source.tar.gz").Replace("'", "\\'")
                    + "'\n"
                    + "NODE_PAIRING_TOKEN='"
                    + hub.Registry.PairingToken
                    + "'\nNODE_ID='"
                    + id
                    + "'\nNODE_DATA_DIR=./data\nFOXWARM_NODE_ENV\nchmod 600 .env\n\ndocker compose up -d --build",
                ["windows"] =
                    "Invoke-WebRequest '"
                    + (url + "/node/run.ps1").Replace("'", "''")
                    + "' -OutFile .\\run.ps1\n.\\run.ps1 -HostUrl '"
                    + url.Replace("'", "''")
                    + "' -Pairing '"
                    + hub.Registry.PairingToken
                    + "' -NodeId '"
                    + id
                    + "'",
            },
        };
    }

    // Browser command suggestions and downloaded-script defaults have different owners.
    internal static string OnboardingBaseUrl(JsonObject body, string? configured)
    {
        var raw =
            body.ContainsKey("baseUrl") ? body["baseUrl"]
            : configured is { Length: > 0 } ? JsonValue.Create(configured)
            : body["fallbackUrl"];
        if (raw is not JsonValue value || !value.TryGetValue<string>(out var text))
            throw new InvalidDataException("Enter an address reachable from the new Node.");
        return NormalizeBaseUrl(text);
    }

    private static string NormalizeBaseUrl(string input)
    {
        var url = input.Trim();
        if (
            url.Any(c => c <= '\x1f' || c == '\x7f')
            || url.Contains('\\')
            || url.Contains('?')
            || url.Contains('#')
            || !System.Text.RegularExpressions.Regex.IsMatch(
                url,
                "^https?://",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            )
            || !Uri.TryCreate(url, UriKind.Absolute, out var parsed)
            || parsed.Host.Length == 0
            || parsed.UserInfo.Length > 0
        )
            throw new InvalidDataException(
                "Enter an HTTP or HTTPS address without a username, password, query, or fragment."
            );
        return parsed.AbsoluteUri.TrimEnd('/');
    }

    internal static string InferRequestBaseUrl(HttpRequest request)
    {
        static string? First(string? value) =>
            value?.Split(',')[0].Trim() is { Length: > 0 } first ? first : null;
        static string? Protocol(string? value) =>
            value?.ToLowerInvariant() is "http" or "https" ? value.ToLowerInvariant() : null;
        var host =
            First(request.Headers["X-Forwarded-Host"].FirstOrDefault())
            ?? First(request.Headers.Host.FirstOrDefault());
        if (
            host is null
            || !System.Text.RegularExpressions.Regex.IsMatch(host, "^[A-Za-z0-9.\\-:\\[\\]]+$")
        )
            return "";
        var protocol =
            Protocol(First(request.Headers["X-Forwarded-Proto"].FirstOrDefault()))
            ?? Protocol(request.Scheme)
            ?? "http";
        return protocol + "://" + host;
    }

    internal string ShellCommand(string url, string id, string auth) =>
        "curl -fsSL "
        + Quote(url.TrimEnd('/') + "/node/run-shell.sh")
        + " -o run-shell.sh\n"
        + "NODE_AUTH_TOKEN="
        + Quote(auth)
        + " sh ./run-shell.sh --host="
        + Quote(url.TrimEnd('/'))
        + " --node-id="
        + Quote(id);

    internal JsonObject Info()
    {
        var result = Commands();
        result["pairingToken"] = hub.Registry.PairingToken;
        result["endpoints"] = new JsonArray(
            Templates
                .Append("source.tar.gz")
                .Select(name =>
                    (JsonNode?)JsonValue.Create(address.BaseUrl.TrimEnd('/') + "/node/" + name)
                )
                .ToArray()
        );
        result["instruction"] =
            "Run a setup command on the existing Node environment. Check that the public address is reachable from that environment.";
        return result;
    }

    internal void Register(WebApplication app)
    {
        foreach (var template in Templates.Append("run-cli-node.sh"))
        {
            var name = template == "run-cli-node.sh" ? "run-interactive.sh" : template;
            app.MapGet(
                "/node/" + template,
                async (HttpContext context) =>
                {
                    var path = Path.Combine(AppContext.BaseDirectory, "templates", "node", name);
                    if (!File.Exists(path))
                    {
                        context.Response.StatusCode = 503;
                        return;
                    }
                    context.Response.ContentType =
                        name.EndsWith(".yaml") ? "text/yaml"
                        : name == "run-shell.sh" ? "text/x-shellscript; charset=utf-8"
                        : "text/plain; charset=utf-8";
                    var text = await File.ReadAllTextAsync(path, context.RequestAborted);
                    await context.Response.WriteAsync(
                        text.Replace(
                            "__FOXWARM_DEFAULT_BASE_URL__",
                            InferRequestBaseUrl(context.Request)
                        ),
                        context.RequestAborted
                    );
                }
            );
        }
        app.MapGet(
            "/node/source.tar.gz",
            async (HttpContext context) =>
            {
                var root = AppContext.BaseDirectory;
                if (Sources.Any(source => !Directory.Exists(Path.Combine(root, source))))
                {
                    context.Response.StatusCode = 503;
                    return;
                }
                context.Response.ContentType = "application/gzip";
                context.Response.Headers.ContentDisposition =
                    "attachment; filename=foxwarm-node-source.tar.gz";
                await using var gzip = new GZipStream(
                    context.Response.Body,
                    CompressionLevel.Fastest,
                    leaveOpen: true
                );
                await using var tar = new TarWriter(gzip, leaveOpen: true);
                foreach (var source in Sources)
                foreach (
                    var path in Directory.EnumerateFiles(
                        Path.Combine(root, source),
                        "*",
                        SearchOption.AllDirectories
                    )
                )
                    await tar.WriteEntryAsync(
                        path,
                        Path.GetRelativePath(root, path).Replace('\\', '/'),
                        context.RequestAborted
                    );
                var script = Path.Combine(root, "scripts", "start-sandbox-node.sh");
                if (File.Exists(script))
                    await tar.WriteEntryAsync(
                        script,
                        "scripts/start-sandbox-node.sh",
                        context.RequestAborted
                    );
            }
        );
    }
}
