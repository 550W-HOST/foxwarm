using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

static string Required(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
    ? value : throw new InvalidOperationException($"Missing experiment host environment variable {name}.");

var dataRoot = Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR") ?? Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var configuration = new ModelConfiguration(dataRoot);
var http = await HttpServerSettings.CaptureAsync(configuration, dataRoot);
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (http.WebUiEnabled && distRoot is not null)
{
    distRoot = Path.GetFullPath(distRoot);
    if (!File.Exists(Path.Combine(distRoot, "index.html")) || !Directory.Exists(Path.Combine(distRoot, "assets")))
        throw new InvalidOperationException("Configured experimental WebUI dist needs index.html and assets/.");
}
var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1/v1"), "", "", "",
    Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_INSTRUCTIONS") ?? "", configuration.MaxOutput);
var models = configuration.Models;
await using var sessions = new SessionManager(dataRoot, workspaceRoot, options, models, Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_SKILLS_ROOT"));
await sessions.LoadMainHostAsync();
var runtime = new SessionRuntime(sessions);
var router = new MessageRouter(runtime);
var server = new HttpServer(args, http.Port, http.Token, distRoot, sessions, http.Address, http.WebUiEnabled);
var webui = new WebUIChannel(sessions, runtime, router);
if (server.WebUiEnabled) webui.Register(server.App);
server.App.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine("Main HTTP listening: " + string.Join(", ", server.App.Urls));
    sessions.StartOnboot();
});
try { await server.App.RunAsync(); }
finally
{
    await sessions.ShutdownAsync();
    await server.App.DisposeAsync();
}
