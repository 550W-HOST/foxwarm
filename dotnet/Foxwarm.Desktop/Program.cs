using System.Security.Principal;
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
        using var instance = new Mutex(
            false,
            "Foxwarm.Desktop." + WindowsIdentity.GetCurrent().User!.Value,
            new NamedWaitHandleOptions { CurrentUserOnly = true, CurrentSessionOnly = false }
        );
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
        {
            DesktopNative.ShowMessage("Foxwarm is already running. Open it from the tray icon.");
            return;
        }
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
                _ = new DesktopApplication();
            });
        }
        finally
        {
            instance.ReleaseMutex();
        }
    }
}

internal sealed partial class DesktopApplication : Application
{
    private DesktopWindow? window;

    internal DesktopApplication()
    {
        Resources.MergedDictionaries.Add(new Microsoft.UI.Xaml.Controls.XamlControlsResources());
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        window = new DesktopWindow();
        window.Activate();
        window.Start();
    }
}
