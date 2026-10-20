using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

if (await Foxwarm.Vector.VectorChild.TryRunAsync(args))
    return;

if (await Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args))
    return;

if (CliCommands.IsCommand(args))
{
    Environment.ExitCode = await CliCommands.RunAsync(args[0]);
    return;
}

if (args is ["--version"] or ["-v"])
{
    Console.WriteLine(ProductVersion.Value);
    return;
}

if (args.Contains("--tui", StringComparer.Ordinal))
{
    Console.Error.WriteLine("Main TUI is not implemented by the managed host. Use the WebUI instead.");
    Environment.ExitCode = 2;
    return;
}
var background = args.Contains("--windows-background", StringComparer.Ordinal);
if (background && !OperatingSystem.IsWindows())
    throw new PlatformNotSupportedException("The Windows background entry requires Windows.");
args = args.Where(value => value != "--windows-background").ToArray();
await using var launcher = await MainLauncherLifetime.ConnectAsync();
if (launcher?.StopRequested.IsCancellationRequested == true)
    return;

var configuration = new ModelConfiguration(HostPaths.Capture());
var paths = configuration.Paths;
if (configuration.AppConfiguration["bot"]?["enableTUI"]?.ToString().Equals("true", StringComparison.OrdinalIgnoreCase) == true)
    Console.Error.WriteLine("Configured bot.enableTUI is ignored: Main TUI is not implemented by the managed host.");
var http = await HttpServerSettings.CaptureAsync(configuration, paths.DataRoot);
var distRoot = Environment.GetEnvironmentVariable("FOXWARM_EXPERIMENT_WEBUI_DIST");
if (distRoot is not null)
    distRoot = HostPaths.Resolve(distRoot, paths.ApplicationRoot);
else
{
    var packaged = Path.Combine(paths.ResourceRoot, "webui-dist");
    var installed = Path.Combine(paths.ApplicationRoot, "packages", "webui", "dist");
    distRoot =
        Directory.Exists(packaged) ? packaged
        : Directory.Exists(installed) ? installed
        : null;
}
if (
    http.WebUiEnabled
    && distRoot is not null
    && (
        !File.Exists(Path.Combine(distRoot, "index.html"))
        || !Directory.Exists(Path.Combine(distRoot, "assets"))
    )
)
    throw new InvalidOperationException("Configured WebUI dist needs index.html and assets/.");
await using var host = await MainHost.CreateAsync(args, configuration, http, distRoot);
host.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine(
        host.HttpEnabled
            ? "Main HTTP listening: " + string.Join(", ", host.App.Urls)
            : "Main started without HTTP."
    );
});
if (launcher?.StopRequested.IsCancellationRequested == true)
    return;
await using var control = WindowsBackgroundControl.Start(background, paths.DataRoot, host.Lifetime);
await host.StartAsync();
using var parentStop = launcher?.StopRequested.Register(host.Lifetime.StopApplication);
await host.WaitForShutdownAsync();
// Keep status/stop available until the exact Main owners have drained.
await host.DisposeAsync();
