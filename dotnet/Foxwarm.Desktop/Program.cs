using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Foxwarm.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (Foxwarm.Tools.ExecNative.Helper(args) is int helperExit)
        {
            Environment.ExitCode = helperExit;
            return;
        }
        if (Foxwarm.Vector.VectorChild.TryRunAsync(args).GetAwaiter().GetResult())
            return;
        if (Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args).GetAwaiter().GetResult())
            return;
        // The installer stops this executable's running copy before changing its files.
        if (args is ["--exit"])
        {
            Environment.ExitCode = DesktopInstance.RequestExit();
            return;
        }
        // A sign-in start stays in the notification area until the window is opened.
        var tray = args is ["--tray"];
        using var instance = DesktopInstance.Lock();
        bool acquired;
        try
        {
            acquired = instance.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            acquired = true;
        }
        // A further start shows the running copy's window; a further sign-in start changes nothing.
        if (!acquired)
        {
            if (!tray)
                DesktopInstance.RequestOpen();
            return;
        }
        using var openRequests = DesktopInstance.OpenRequests();
        using var exitRequests = DesktopInstance.ExitRequests();
        try
        {
            // Initialize the self-contained WinRT runtime only after private helper dispatch.
            Microsoft.Windows.Foundation.UndockedRegFreeWinRTCS.AutoInitialize.AccessWindowsAppSDK();
            WinRT.ComWrappersSupport.InitializeComWrappers();
            Application.Start(initialization =>
            {
                SynchronizationContext.SetSynchronizationContext(
                    new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread())
                );
                _ = new DesktopApplication(tray, openRequests, exitRequests);
            });
        }
        finally
        {
            instance.ReleaseMutex();
        }
    }
}

public sealed partial class DesktopApplication : Application
{
    private readonly bool tray;
    private readonly WaitHandle openRequests;
    private readonly WaitHandle exitRequests;
    private DesktopWindow? window;
    private RegisteredWaitHandle? openRequest;
    private RegisteredWaitHandle? exitRequest;

    internal DesktopApplication(bool tray, WaitHandle openRequests, WaitHandle exitRequests)
    {
        this.tray = tray;
        this.openRequests = openRequests;
        this.exitRequests = exitRequests;
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var window = new DesktopWindow();
        this.window = window;
        window.Start(tray);
        openRequest = ThreadPool.RegisterWaitForSingleObject(
            openRequests,
            (_, _) => window.DispatcherQueue.TryEnqueue(window.OpenWindow),
            null,
            Timeout.Infinite,
            executeOnlyOnce: false
        );
        exitRequest = ThreadPool.RegisterWaitForSingleObject(
            exitRequests,
            (_, _) => window.DispatcherQueue.TryEnqueue(window.ExitApplication),
            null,
            Timeout.Infinite,
            executeOnlyOnce: true
        );
    }
}
