using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"Missing experiment host environment variable {name}.");

var dataRoot = Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var modelsFile = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_MODELS_FILE");
if (string.IsNullOrWhiteSpace(modelsFile)) modelsFile = null;
var providerUri = new Uri(modelsFile is null ? Required("FOXWARM_EXPERIMENT_RESPONSES_BASE_URI")
    : Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_RESPONSES_BASE_URI") ?? "http://127.0.0.1:1/v1", UriKind.Absolute);
var providerToken = modelsFile is null ? Required("FOXWARM_EXPERIMENT_PROVIDER_TOKEN")
    : Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_PROVIDER_TOKEN") ?? "";
var apiToken = Required("FOXWARM_EXPERIMENT_API_TOKEN");
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (distRoot is not null)
{
    distRoot = Path.GetFullPath(distRoot);
    if (!File.Exists(Path.Combine(distRoot, "index.html")) || !Directory.Exists(Path.Combine(distRoot, "assets")))
        throw new InvalidOperationException("Configured experimental WebUI dist needs index.html and assets/.");
}
var port = int.Parse(Required("FOXWARM_EXPERIMENT_PORT"));
if (port is <= 0 or > 65535) throw new ArgumentException("Port must be between 1 and 65535.");
var options = new ResponsesClientOptions(providerUri, modelsFile is null ? Required("FOXWARM_EXPERIMENT_REQUEST_MODEL") : "placeholder",
    modelsFile is null ? Required("FOXWARM_EXPERIMENT_CONCRETE_MODEL") : "placeholder", providerToken,
    Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "",
    int.TryParse(Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS"), out var limit) ? limit : 1024);
var models = HostModels.Load(modelsFile, options);
await using var sessions = new SessionManager(dataRoot, workspaceRoot, options, models);
await sessions.LoadAsync();
var runtime = new SessionRuntime(sessions);
var router = new MessageRouter(runtime);
var server = new HttpServer(args, port, apiToken, distRoot, sessions);
var webui = new WebUIChannel(sessions, runtime, router);
webui.Register(server.App);
try { await server.App.RunAsync(); }
finally
{
    await sessions.ShutdownAsync();
    await server.App.DisposeAsync();
}
