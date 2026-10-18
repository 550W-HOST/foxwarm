using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

if (await Foxwarm.Vector.VectorChild.TryRunAsync(args))
    return;

if (await Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args))
    return;

var configuration = new ModelConfiguration(HostPaths.Capture());
var paths = configuration.Paths;
var http = await HttpServerSettings.CaptureAsync(configuration, paths.DataRoot);
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (distRoot is not null)
    distRoot = HostPaths.Resolve(distRoot, paths.ApplicationRoot);
else
{
    var packaged = Path.Combine(paths.ResourceRoot, "webui-dist");
    var installed = Path.Combine(paths.ApplicationRoot, "packages", "webui", "dist");
    distRoot = Directory.Exists(packaged) ? packaged : Directory.Exists(installed) ? installed : null;
}
if (http.WebUiEnabled && distRoot is not null
    && (!File.Exists(Path.Combine(distRoot, "index.html"))
        || !Directory.Exists(Path.Combine(distRoot, "assets"))))
    throw new InvalidOperationException("Configured WebUI dist needs index.html and assets/.");
await using var host = await MainHost.CreateAsync(args, configuration, http, distRoot);
host.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine(host.HttpEnabled
        ? "Main HTTP listening: " + string.Join(", ", host.App.Urls)
        : "Main started without HTTP.");
});
await host.StartAsync();
await host.WaitForShutdownAsync();
