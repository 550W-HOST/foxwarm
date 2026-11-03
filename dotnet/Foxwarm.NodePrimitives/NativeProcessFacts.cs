using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Foxwarm.Tools;

internal static class NativeProcessFacts
{
    [System.Runtime.InteropServices.DllImport("libc", EntryPoint = "access", SetLastError = true)]
    internal static extern int Access(
        [System.Runtime.InteropServices.MarshalAs(
            System.Runtime.InteropServices.UnmanagedType.LPUTF8Str
        )]
            string path,
        int mode
    );

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
            if (OperatingSystem.IsMacOS())
            {
                if (ReadDarwinProcess(pid, 3, 0, out var info, 136) != 136)
                    return (null, '?');
                return (
                    $"{info.StartSeconds.ToString(CultureInfo.InvariantCulture)}:{info.StartMicroseconds.ToString(CultureInfo.InvariantCulture)}",
                    info.Status == 5 ? 'Z' : 'R'
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
    internal static string? ReadDarwinWorkingDirectory(int pid)
    {
        // PROC_PIDVNODEPATHINFO contains current/root vnode_info_path structures.
        // Fixed 64-bit Darwin ABI: current directory path at byte 152, MAXPATHLEN 1024.
        var buffer = new byte[2352];
        if (ReadDarwinPaths(pid, 9, 0, buffer, buffer.Length) != buffer.Length)
            return null;
        var end = Array.IndexOf(buffer, (byte)0, 152, 1024);
        return end > 152 ? Encoding.UTF8.GetString(buffer, 152, end - 152) : null;
    }

    [StructLayout(LayoutKind.Explicit, Size = 136)]
    private struct DarwinProcessInfo
    {
        [FieldOffset(4)] internal uint Status;
        [FieldOffset(120)] internal ulong StartSeconds;
        [FieldOffset(128)] internal ulong StartMicroseconds;
    }

    [DllImport("/usr/lib/libproc.dylib", EntryPoint = "proc_pidinfo", SetLastError = true)]
    private static extern int ReadDarwinProcess(int pid, int flavor, ulong arg,
        out DarwinProcessInfo info, int size);

    [DllImport("/usr/lib/libproc.dylib", EntryPoint = "proc_pidinfo", SetLastError = true)]
    private static extern int ReadDarwinPaths(int pid, int flavor, ulong arg,
        [Out] byte[] info, int size);

}
