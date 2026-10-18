using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

if (await Foxwarm.Vector.VectorChild.TryRunAsync(args))
    return;

if (await Foxwarm.Terminal.CodeHelperClient.TryRunAsync(args))
    return;

static string Required(string name) =>
    Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
        ? value
        : throw new InvalidOperationException(
            $"Missing experiment host environment variable {name}."
        );

var dataRoot =
    Environment.GetEnvironmentVariable("FOXWARM_DATA_DIR")
    ?? Required("FOXWARM_EXPERIMENT_DATA_ROOT");
var workspaceRoot = Required("FOXWARM_EXPERIMENT_TOOL_ROOT");
var configuration = new ModelConfiguration(dataRoot);
var http = await HttpServerSettings.CaptureAsync(configuration, dataRoot);
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (http.WebUiEnabled && distRoot is not null)
{
    distRoot = Path.GetFullPath(distRoot);
    if (
        !File.Exists(Path.Combine(distRoot, "index.html"))
        || !Directory.Exists(Path.Combine(distRoot, "assets"))
    )
        throw new InvalidOperationException(
            "Configured experimental WebUI dist needs index.html and assets/."
        );
}
await using var host = await MainHost.CreateAsync(
    args,
    dataRoot,
    workspaceRoot,
    configuration,
    http,
    distRoot
);
host.App.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine("Main HTTP listening: " + string.Join(", ", host.App.Urls));
});
await host.App.StartAsync();
await host.WaitForShutdownAsync();
