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
        using var instance = new Mutex(false, "Foxwarm.Desktop." + Environment.UserName);
        bool acquired;
        try
        {
            acquired = instance.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            acquired = true;
        }
        if (!acquired)
            return;
        try
        {
            NSApplication.Init();
            NSApplication.SharedApplication.Delegate = new DesktopApplication();
            NSApplication.Main(args);
        }
        finally
        {
            instance.ReleaseMutex();
        }
    }
}
