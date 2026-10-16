namespace Foxwarm.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var instance = new Mutex(
            false,
            "Foxwarm.Desktop",
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
            MessageBox.Show(
                "Foxwarm is already running. Open it from the tray icon.",
                "Foxwarm",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
            return;
        }
        try
        {
            Application.Run(new DesktopWindow());
        }
        finally
        {
            instance.ReleaseMutex();
        }
    }
}
