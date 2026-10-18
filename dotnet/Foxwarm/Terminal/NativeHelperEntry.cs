using System.Runtime.InteropServices;
using System.Text;

namespace Foxwarm.Terminal;

/// <summary>Private same-executable helper dispatch, before Main or Desktop startup.</summary>
public static class NativeHelperEntry
{
    public static async Task<bool> TryRunAsync(string[] args)
    {
        if (args.Length == 0 || args[0] != "--code-helper")
            return false;
        if (OperatingSystem.IsWindows() && AttachConsole(uint.MaxValue))
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
        }
        try
        {
            return await CodeHelperClient.TryRunAsync(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            Environment.ExitCode = 1;
            return true;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);
}
