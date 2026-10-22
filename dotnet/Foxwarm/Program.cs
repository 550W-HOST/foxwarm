using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

if (Foxwarm.Tools.ExecNative.Helper(args) is int execHelperExit)
{
    Environment.ExitCode = execHelperExit;
    return;
}

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
    Console.Error.WriteLine(
        "Main TUI is not implemented by the managed host. Use the WebUI instead."
    );
    Environment.ExitCode = 2;
    return;
}
try
{
    var background = args.Contains("--windows-background", StringComparer.Ordinal);
    if (background && !OperatingSystem.IsWindows())
        throw new PlatformNotSupportedException("The Windows background entry requires Windows.");
    args = args.Where(value => value != "--windows-background").ToArray();
    await using var launcher = await MainLauncherLifetime.ConnectAsync();
    if (launcher?.StopRequested.IsCancellationRequested == true)
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
    await using var host = await MainHost.CreateAsync(
        args,
        configuration,
        http,
        distRoot,
        captureDiagnostics: true
    );
    if (launcher?.StopRequested.IsCancellationRequested == true)
        return;
    await using var control = WindowsBackgroundControl.Start(
        background,
        paths.DataRoot,
        host.Lifetime
    );
    using var parentStop = launcher?.StopRequested.Register(host.Lifetime.StopApplication);
    await host.StartAsync();
    await host.WaitForShutdownAsync();

    // Keep status/stop available until the exact Main owners have drained.
    await host.DisposeAsync();
}
catch (Exception error)
{
    // MainHost records composition/start failures before disposing capture. This also covers
    // configuration and logging failures before a MainLog exists, without an unsafe CLR dump.
    MainLog.Fatal("entry", error);
    Environment.ExitCode = 1;
}
