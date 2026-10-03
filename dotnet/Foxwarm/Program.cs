using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"Missing experiment host environment variable {name}.");

var dataRoot = Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR") ?? Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var configuration = new ModelConfiguration(dataRoot);
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
var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1/v1"), "", "", "",
    Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "", configuration.MaxOutput);
var models = configuration.Models;
await using var sessions = new SessionManager(dataRoot, workspaceRoot, options, models, Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_SKILLS_ROOT"));
await sessions.LoadMainHostAsync();
var runtime = new SessionRuntime(sessions);
var router = new MessageRouter(runtime);
var server = new HttpServer(args, port, apiToken, distRoot, sessions);
var webui = new WebUIChannel(sessions, runtime, router);
webui.Register(server.App);
server.App.Lifetime.ApplicationStarted.Register(sessions.StartOnboot);
try { await server.App.RunAsync(); }
finally
{
    await sessions.ShutdownAsync();
    await server.App.DisposeAsync();
}
