using System.Diagnostics;
using System.Globalization;

namespace Foxwarm.Tools;

internal static class NativeProcessFacts
{
    [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "access", SetLastError = true)]
    internal static extern int Access([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPUTF8Str)] string path, int mode);

    internal static (string? Ticks, char State) ReadIdentity(int pid)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var process = Process.GetProcessById(pid);
                return process.HasExited
                    ? (null, '?')
                    : (
                        process
                            .StartTime.ToUniversalTime()
                            .Ticks.ToString(CultureInfo.InvariantCulture),
                        'R'
                    );
            }
            var raw = File.ReadAllText($"/proc/{pid}/stat");
            var close = raw.LastIndexOf(')');
            if (close < 0 || close + 2 >= raw.Length)
                return (null, '?');
            var fields = raw[(close + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return fields.Length > 19 ? (fields[19], fields[0][0]) : (null, '?');
        }
        catch (ArgumentException)
        {
            return (null, '?');
        }
        catch (InvalidOperationException)
        {
            return (null, '?');
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return (null, '?');
        }
        catch (IOException)
        {
            return (null, '?');
        }
        catch (UnauthorizedAccessException)
        {
            return (null, '?');
        }
    }

}
