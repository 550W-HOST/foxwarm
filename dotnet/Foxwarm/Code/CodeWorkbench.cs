using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Code;

internal sealed partial class CodeWorkbench
{
    private readonly PublicWebAddress publicAddress;
    private readonly string applicationRoot = Path.GetFullPath(AppContext.BaseDirectory);
    private readonly string dataRoot;
    private readonly string? appConfig;
    private readonly string? modelsConfig;
    private readonly string assetRoot;
    private readonly string extensionRoot;
    private readonly string yamlRoot;
    private readonly string? configuredOrigin;
    private readonly string defaultFolder;
    private readonly string workspacePath;
    private readonly bool hasPty;
    private readonly Foxwarm.Nodes.NodeConnectionHub nodes;
    private readonly object workspaceGate = new();
    private readonly string capabilityRoute =
        "webview/" + Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    private static readonly JsonObject PrivacyDefaults = new()
    {
        ["redhat.telemetry.enabled"] = false,
        ["yaml.schemaStore.enable"] = false,
        ["yaml.kubernetesCRDStore.enable"] = false,
        ["yaml.extension.recommendations"] = false,
    };

    internal CodeWorkbench(SessionManager sessions, PublicWebAddress address, bool hasPty)
    {
        this.hasPty = hasPty;
        nodes = sessions.Nodes;
        publicAddress = address;
        dataRoot = sessions.DataRoot;
        var config = sessions.Models.ConfigurationOwner;
        appConfig = config is null ? null : Path.GetFullPath(config.AppPath);
        modelsConfig = config is null ? null : Path.GetFullPath(config.ActivePath);
        assetRoot = Environment.GetEnvironmentVariable("FOXWARM_VSCODE_WEB_ASSET_DIR")
            is { Length: > 0 } assets
            ? Path.GetFullPath(assets)
            : Path.Combine(applicationRoot, "packages", "vscode-web", "assets", "vscode-web");
        extensionRoot = Path.Combine(applicationRoot, "packages", "vscode-web");
        yamlRoot = Environment.GetEnvironmentVariable("FOXWARM_VSCODE_YAML_EXTENSION_DIR")
            is { Length: > 0 } yaml
            ? Path.GetFullPath(yaml)
            : Path.Combine(
                applicationRoot,
                "packages",
                "vscode-web",
                "assets",
                "extensions",
                "redhat.vscode-yaml"
            );
        configuredOrigin = Environment
            .GetEnvironmentVariable("FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN")
            ?.Trim()
            .TrimEnd('/');
        defaultFolder = Environment
            .GetEnvironmentVariable("FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI")
            ?.Trim()
            is { Length: > 0 } folder
            ? folder
            : FoxwarmUri(applicationRoot);
        workspacePath = Environment.GetEnvironmentVariable("FOXWARM_VSCODE_WEB_WORKSPACE_PATH")
            is { Length: > 0 } workspace
            ? Path.GetFullPath(workspace)
            : Path.Combine(dataRoot, "state", "vscode-web", "foxwarm.code-workspace");
    }

    private bool Prepared =>
        new[]
        {
            "out/nls.messages.js",
            "out/vs/workbench/workbench.web.main.internal.css",
            "out/vs/workbench/workbench.web.main.internal.js",
        }.All(file => File.Exists(Path.Combine(assetRoot, file)));
    private bool HasYaml => File.Exists(Path.Combine(yamlRoot, "package.json"));

    internal JsonObject Roots()
    {
        if (appConfig is null || modelsConfig is null)
            throw new CodeServiceException(
                "Unavailable",
                "Active configuration descriptors are unavailable."
            );
        static JsonObject Descriptor(string path) =>
            new() { ["nodeId"] = "master", ["path"] = path };
        return new()
        {
            ["version"] = 1,
            ["roots"] = new JsonObject
            {
                ["app"] = Descriptor(applicationRoot),
                ["data"] = Descriptor(dataRoot),
            },
            ["configFiles"] = new JsonObject
            {
                ["app"] = Descriptor(appConfig),
                ["models"] = Descriptor(modelsConfig),
            },
        };
    }

    internal static string FoxwarmUri(string path) =>
        "foxwarm://node+master" + string.Join('/', path.Split('/').Select(Uri.EscapeDataString));

    private static JsonObject UriParts(string text)
    {
        if (text.StartsWith("foxwarm://", StringComparison.Ordinal))
        {
            var match = Regex.Match(text, "^foxwarm://([^/?#]+)([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$");
            if (!match.Success)
                throw new CodeServiceException("InvalidPath", "Invalid Code workspace URI.");
            return new()
            {
                ["scheme"] = "foxwarm",
                ["authority"] = match.Groups[1].Value,
                ["path"] = match.Groups[2].Value.Length > 0 ? match.Groups[2].Value : "/",
                ["query"] = match.Groups[3].Value,
                ["fragment"] = match.Groups[4].Value,
            };
        }
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri))
            throw new CodeServiceException("InvalidPath", "Invalid Code workspace URI.");
        return new()
        {
            ["scheme"] = uri.Scheme,
            ["authority"] = uri.Authority,
            ["path"] = uri.AbsolutePath,
            ["query"] = uri.Query.TrimStart('?'),
            ["fragment"] = uri.Fragment.TrimStart('#'),
        };
    }

    private string Workspace(string folder)
    {
        if (!folder.StartsWith("foxwarm://", StringComparison.Ordinal))
            throw new CodeServiceException(
                "InvalidPath",
                "folderUri must use the foxwarm:// scheme."
            );
        _ = UriParts(folder);
        lock (workspaceGate)
        {
            if (!File.Exists(workspacePath))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(workspacePath)!);
                File.WriteAllText(
                    workspacePath,
                    new JsonObject
                    {
                        ["folders"] = new JsonArray(new JsonObject { ["uri"] = folder }),
                        ["settings"] = PrivacyDefaults.DeepClone(),
                    }.ToJsonString(new() { WriteIndented = true })
                );
            }
            else
            {
                try
                {
                    if (JsonNode.Parse(File.ReadAllText(workspacePath)) is JsonObject workspace)
                    {
                        var settings = workspace["settings"] as JsonObject;
                        var changed = settings is null;
                        if (settings is null)
                            workspace["settings"] = settings = new();
                        foreach (var setting in PrivacyDefaults)
                            if (!settings.ContainsKey(setting.Key))
                            {
                                settings[setting.Key] = setting.Value!.DeepClone();
                                changed = true;
                            }
                        if (changed)
                            File.WriteAllText(
                                workspacePath,
                                workspace.ToJsonString(new() { WriteIndented = true })
                            );
                    }
                }
                catch (System.Text.Json.JsonException)
                { /* Keep malformed persisted workspaces for Code to report. */
                }
            }
        }
        return FoxwarmUri(workspacePath);
    }

    internal string Bootstrap(HttpContext context)
    {
        var address = publicAddress;
        var origin = address.Origin;
        if (!string.IsNullOrEmpty(configuredOrigin) && configuredOrigin != origin)
            throw new CodeServiceException(
                "InvalidPath",
                "Code webviews require the Main public origin."
            );
        var folder =
            context
                .Request.Query[
                    context.Request.Query["embedded"] == "true" ? "initialFolderUri" : "folderUri"
                ]
                .FirstOrDefault() ?? defaultFolder;
        if (!folder.StartsWith("foxwarm://", StringComparison.Ordinal))
            throw new CodeServiceException(
                "InvalidPath",
                "folderUri must use the foxwarm:// scheme."
            );
        var route = address.Prefix.ToUriComponent() + "/vscode-web";
        var baseUrl = origin + route + "/static";
        var extensions = new JsonArray();
        foreach (
            var name in hasPty
                ? new[] { "foxwarm-fs", "foxwarm-scm", "foxwarm-webui", "foxwarm-terminal" }
                : new[] { "foxwarm-fs", "foxwarm-scm", "foxwarm-webui" }
        )
            extensions.Add(UriParts(origin + route + "/extensions/" + name));
        if (HasYaml)
            extensions.Add(UriParts(origin + route + "/extensions/redhat-vscode-yaml"));
        var configuration = new JsonObject
        {
            [context.Request.Query["embedded"] == "true" ? "workspaceUri" : "folderUri"] = UriParts(
                context.Request.Query["embedded"] == "true" ? Workspace(folder) : folder
            ),
            ["callbackRoute"] = route + "/callback",
            ["productConfiguration"] = new JsonObject
            {
                ["enableTelemetry"] = false,
                ["webEndpointUrlTemplate"] = baseUrl,
                ["webviewContentExternalBaseUrlTemplate"] =
                    origin + route + "/" + capabilityRoute + "/{{uuid}}/",
            },
            ["additionalBuiltinExtensions"] = extensions,
            ["configurationDefaults"] = new JsonObject { ["window.menuBarVisibility"] = "visible" },
        };
        foreach (var setting in PrivacyDefaults)
            configuration["configurationDefaults"]![setting.Key] = setting.Value!.DeepClone();
        using var resource = Assembly
            .GetExecutingAssembly()
            .GetManifestResourceStream("Foxwarm.Code.workbench.html")!;
        using var reader = new StreamReader(resource);
        return reader
            .ReadToEnd()
            .Replace("@@CONFIGURATION@@", WebUtility.HtmlEncode(configuration.ToJsonString()))
            .Replace(
                "@@ASSETBASE@@",
                context.Request.Path.Value?.EndsWith('/') == true ? "./static" : route + "/static"
            )
            .Replace("@@BASEURL@@", JsonValue.Create(baseUrl)!.ToJsonString())
            .Replace("@@WEBVIEWROUTE@@", JsonValue.Create(capabilityRoute)!.ToJsonString())
            .Replace("@@CALLBACK@@", JsonValue.Create(route + "/callback")!.ToJsonString())
            .Replace("@@HASYAML@@", HasYaml ? "true" : "false")
            .Replace("@@HASPTY@@", hasPty ? "true" : "false");
    }

    private static string PatchWorkbench(string source)
    {
        // Upstream minification changes names; retain the supported helper shape instead.
        var functionMatch = Regex.Match(
            source,
            """async function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{if\(!crypto\.subtle\)throw new Error\("'crypto\.subtle' is not available[^;]+;[\s\S]*?return [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\}""",
            RegexOptions.ECMAScript
        );
        if (!functionMatch.Success)
            throw new CodeServiceException(
                "Unavailable",
                "Code webview assets do not match the supported workbench."
            );
        var original = functionMatch.Value;
        var patched = new Regex("""if\(!crypto\.subtle\)throw new Error\("[^\"]+"\);""").Replace(
            original,
            "",
            1
        );
        patched = new Regex(
            """crypto\.subtle\.digest\("sha-256",([A-Za-z_$][\w$]*)\)""",
            RegexOptions.ECMAScript
        ).Replace(
            patched,
            "(crypto.subtle ? crypto.subtle.digest(\"sha-256\",$1) : globalThis.__foxwarmSha256Digest(\"sha-256\",$1))",
            1
        );
        if (patched == original || !patched.Contains("__foxwarmSha256Digest"))
            throw new CodeServiceException(
                "Unavailable",
                "Code webview hash fallback is incompatible with these assets."
            );
        source =
            source[..functionMatch.Index]
            + patched
            + source[(functionMatch.Index + original.Length)..];
        var clipboardMatch = Regex.Match(
            source,
            """async hasResources\(\)\{try\{let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(\)\.navigator\.clipboard\.read\(\);""",
            RegexOptions.ECMAScript
        );
        if (!clipboardMatch.Success)
            throw new CodeServiceException(
                "Unavailable",
                "Code Explorer clipboard assets are incompatible."
            );
        var clipboard =
            "async hasResources(){if(/Firefox\\//.test(navigator.userAgent))return this.resources.length>0;try{let "
            + clipboardMatch.Groups[1].Value
            + "=await "
            + clipboardMatch.Groups[2].Value
            + "().navigator.clipboard.read();";
        return source[..clipboardMatch.Index]
            + clipboard
            + source[(clipboardMatch.Index + clipboardMatch.Length)..];
    }

    private static string PatchPre(string source)
    {
        const string flag =
            "const disableServiceWorker = searchParams.has('disableServiceWorker');";
        const string fallback =
            "const disableServiceWorker = searchParams.has('disableServiceWorker') || !window.isSecureContext || (() => { try { return new URL(searchParams.get('parentOrigin')).origin === window.location.origin; } catch { return false; } })();";
        const string check =
            "if (new URL(parentOrigin).origin === new URL(location.href).origin) {\n\t\t\t\t\treturn start(parentOrigin);\n\t\t\t\t}";
        var html = source
            .Replace(flag, fallback)
            .Replace(
                "if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {",
                "if (new URL(parentOrigin).origin === new URL(location.href).origin || hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {"
            );
        html = Regex.Replace(
            html,
            "(const hostname = location\\.hostname;)\\s*(if \\(!crypto\\.subtle\\) \\{)",
            "$1\n\n\t\t\t\t" + check + "\n\n\t\t\t\t$2"
        );
        var script = Regex.Match(html, "<script async type=\"module\">([\\s\\S]*?)</script>");
        if (!html.Contains(fallback) || !html.Contains(check) || !script.Success)
            throw new CodeServiceException(
                "Unavailable",
                "Code webview bootstrap assets are incompatible."
            );
        var hash = Convert.ToBase64String(
            SHA256.HashData(Encoding.UTF8.GetBytes(script.Groups[1].Value))
        );
        var updated = Regex.Replace(
            html,
            "script-src 'sha256-[^']+' 'self'",
            "script-src 'sha256-" + hash + "' 'self'"
        );
        if (updated == html)
            throw new CodeServiceException(
                "Unavailable",
                "Code webview CSP assets are incompatible."
            );
        return updated;
    }
}
