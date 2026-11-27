using Foxwarm;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

MainLog.TakeStartupFailureLog();

// The launcher supplies its known installation identity independently of payload resources.
// This internal entry metadata is not a public CLI configuration option.
string? applicationRoot = null;
if (args is ["--installation-root", var installationRoot, ..])
{
    applicationRoot = installationRoot;
    args = args[2..];
}

if (Foxwarm.Tools.ExecNative.Helper(args) is int execHelperExit)
{
    Environment.ExitCode = execHelperExit;
    return;
}

if (await Foxwarm.Vector.VectorChild.TryRunAsync(args))
    return;

if (await Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args))
    return;

if (args is ["db", ..] or ["hosted", "import" or "token" or "health" or "agents", ..])
{
#if FOXWARM_HOSTED
    Environment.ExitCode = await Foxwarm.Hosted.HostedCli.RunAsync(args, Console.Out, Console.Error);
#else
    Console.Error.WriteLine("This build of Foxwarm doesn't include hosted mode.");
    Environment.ExitCode = 2;
#endif
    return;
}

if (CliCommands.IsCommand(args))
{
    Environment.ExitCode = await CliCommands.RunAsync(args[0], applicationRoot);
    return;
}

if (args is ["--inspect-upgrade"])
{
    Environment.ExitCode = SessionUpgradeInspection.Run(applicationRoot);
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
// FOXWARM_MODE selects the deployment shape: file mode (the default) or hosted mode.
switch (Environment.GetEnvironmentVariable("FOXWARM_MODE"))
{
    case null or "" or "file":
        break;
    case "hosted":
#if FOXWARM_HOSTED
        Environment.ExitCode = await Foxwarm.Hosted.HostedEntry.RunAsync();
#else
        Console.Error.WriteLine("This build of Foxwarm doesn't include hosted mode.");
        Environment.ExitCode = 2;
#endif
        return;
    case var mode:
        Console.Error.WriteLine($"FOXWARM_MODE must be `file` or `hosted`, not `{mode}`.");
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

    var captured = HostPaths.Capture(applicationRoot);
    // Held until the process exits, after the host below has drained and disposed.
    using var installation = InstallationLock.Acquire(captured.DataRoot);
    var configuration = new ModelConfiguration(captured);
    var paths = configuration.Paths;
    var http = await HttpServerSettings.CaptureAsync(configuration, paths.DataRoot);
    var distRoot = HttpAssets.WebUiDirectory(paths, validate: http.WebUiEnabled);
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
