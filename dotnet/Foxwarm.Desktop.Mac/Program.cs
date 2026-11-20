using AppKit;

namespace Foxwarm.Desktop;

internal static class Program
{
    private static void Main(string[] args)
    {
        // Restore the caller's cwd before helpers: the Apple launcher changes it
        // to the signed bundle before reaching the managed entry point.
        Directory.SetCurrentDirectory(ObjCRuntime.Runtime.OriginalWorkingDirectory!);
        // NativeAOT defaults to Contents/MacOS; Main's shared resource graph lives
        // beside the Apple SDK's managed assemblies in Contents/MonoBundle.
        AppContext.SetData(
            "APP_CONTEXT_BASE_DIRECTORY",
            Path.Combine(Foundation.NSBundle.MainBundle.BundlePath, "Contents", "MonoBundle")
        );
        if (Foxwarm.Tools.ExecNative.Helper(args) is int helperExit)
        {
            Environment.ExitCode = helperExit;
            return;
        }
        if (Foxwarm.Vector.VectorChild.TryRunAsync(args).GetAwaiter().GetResult())
            return;
        if (Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args).GetAwaiter().GetResult())
            return;
        using var instance = AcquireInstance();
        if (instance is null)
        {
            ActivateRunningInstance();
            return;
        }
        NSApplication.Init();
        NSApplication.SharedApplication.Delegate = new DesktopApplication();
        NSApplication.Main(args);
    }

    // One instance per user. NativeAOT's named Mutex is process-local on Unix, so the
    // instance holds an exclusive advisory lock (flock) instead; the system releases it
    // when the process exits, also after a crash.
    private static FileStream? AcquireInstance()
    {
        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Library",
            "Application Support",
            "Foxwarm",
            "Desktop"
        );
        Directory.CreateDirectory(directory);
        try
        {
            return new FileStream(
                Path.Combine(directory, "instance.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            );
        }
        catch (IOException)
        {
            return null;
        }
    }

    // Hand a second launch, such as `open -n`, to the running instance the way a Finder or
    // Dock launch does: LaunchServices activates it and its reopen handler shows the window.
    private static void ActivateRunningInstance()
    {
        NSApplication.Init();
        var running = NSRunningApplication
            .GetRunningApplications(Foundation.NSBundle.MainBundle.BundleIdentifier)
            .FirstOrDefault(application =>
                application.ProcessIdentifier != Environment.ProcessId
                && !application.Terminated
            );
        if (running?.BundleUrl is not { } bundle)
            return;
        using var opened = new ManualResetEventSlim();
        NSWorkspace.SharedWorkspace.OpenApplication(
            bundle,
            NSWorkspaceOpenConfiguration.Create(),
            (_, _) => opened.Set()
        );
        opened.Wait(TimeSpan.FromSeconds(10));
    }
}
