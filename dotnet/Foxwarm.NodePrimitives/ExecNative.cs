using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Helpers run before ordinary client startup, from the same managed or native executable.
internal static class ExecNative
{
    internal static string WindowsPowerShell => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");

    internal static bool Supported => OperatingSystem.IsLinux() || OperatingSystem.IsWindows();
    internal static string SelfCommand => Command(SelfStart());

    internal static string Command(ProcessStartInfo start) =>
        string.Join(" ", new[] { start.FileName }.Concat(start.ArgumentList).Select(Quote));

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage("SingleFile", "IL3000", Justification = "Embedded hosts supply an on-disk managed owner; deployed single-file entries use their actual executable.")]
    internal static ProcessStartInfo SelfStart(System.Reflection.Assembly? owner = null)
    {
        var process = Environment.ProcessPath
            ?? throw new IOException("Cannot locate the executable.");
        var entry = System.Reflection.Assembly.GetEntryAssembly();
        var isOwner = owner is null || entry == owner || entry?.GetName().Name == "Foxwarm.Desktop";
        var dotnet = Path.GetFileNameWithoutExtension(process)
            .Equals("dotnet", StringComparison.OrdinalIgnoreCase);
        var apphost = isOwner && !dotnet;
        var start = new ProcessStartInfo(apphost || dotnet ? process
            : Environment.GetEnvironmentVariable("DOTNET_HOST_PATH")
                ?? Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")
                    ?? throw new IOException("The .NET host path is unavailable."),
                    OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"));
        if (!apphost)
            start.ArgumentList.Add(isOwner ? Environment.GetCommandLineArgs()[0] : owner!.Location);
        return start;
    }

    internal static string Quote(string value) =>
        "'" + value.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    internal static int? Helper(string[] args)
    {
        if (args.Length == 0)
            return null;
        if (args[0] == "--exec-paths" && args.Length == 5)
        {
            File.WriteAllText(
                args[1],
                new JsonObject
                {
                    ["logPath"] = args[2],
                    ["statusPath"] = args[3],
                    ["cwdPath"] = args[4],
                }.ToJsonString() + "\n"
            );
            return 0;
        }
        if (args[0] == "--exec-status" && args.Length == 3)
        {
            File.WriteAllText(
                args[1],
                new JsonObject
                {
                    ["exitCode"] =
                        args[2] == "null" ? null : int.Parse(args[2], CultureInfo.InvariantCulture),
                    ["finishedAt"] = DateTimeOffset.UtcNow.ToString(
                        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                        CultureInfo.InvariantCulture
                    ),
                }.ToJsonString() + "\n"
            );
            return 0;
        }
        if (args[0] != "--exec-launch" || args.Length != 2)
            return null;
        if (Setsid() < 0)
            throw new IOException("Cannot detach exec shell.");
        var fd = Open("/dev/null", 2);
        if (fd < 0)
            throw new IOException("Cannot open exec standard streams.");
        try
        {
            for (var target = 0; target < 3; target++)
                if (Dup2(fd, target) < 0)
                    throw new IOException("Cannot detach exec standard streams.");
        }
        finally
        {
            if (fd > 2)
                Close(fd);
        }
        var strings = new[] { "/bin/bash", args[1] }
            .Select(Marshal.StringToCoTaskMemUTF8)
            .ToArray();
        var argv = Marshal.AllocHGlobal(IntPtr.Size * 3);
        try
        {
            for (var i = 0; i < strings.Length; i++)
                Marshal.WriteIntPtr(argv, i * IntPtr.Size, strings[i]);
            Marshal.WriteIntPtr(argv, 2 * IntPtr.Size, IntPtr.Zero);
            Execv("/bin/bash", argv);
            throw new IOException(
                "Cannot start exec shell: errno " + Marshal.GetLastPInvokeError()
            );
        }
        finally
        {
            foreach (var value in strings)
                Marshal.FreeCoTaskMem(value);
            Marshal.FreeHGlobal(argv);
        }
    }

    internal static ProcessStartInfo Launcher(string script, string cwd, ProcessStartInfo? self = null)
    {
        self ??= SelfStart();
        var start = OperatingSystem.IsWindows()
            ? new ProcessStartInfo("powershell.exe")
            : self;
        start.UseShellExecute = false;
        start.WorkingDirectory = cwd;
        start.CreateNoWindow = true;
        if (OperatingSystem.IsWindows())
            foreach (
                var argument in new[]
                {
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    script,
                }
            )
                start.ArgumentList.Add(argument);
        else
        {
            start.ArgumentList.Add("--exec-launch");
            start.ArgumentList.Add(script);
        }
        return start;
    }

    internal static bool IsRunning(int pid)
    {
        if (!OperatingSystem.IsWindows())
            return Kill(pid, 0) == 0 || Marshal.GetLastPInvokeError() == 1;
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    [DllImport("libc", EntryPoint = "setsid", SetLastError = true)]
    private static extern int Setsid();

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "dup2", SetLastError = true)]
    private static extern int Dup2(int oldfd, int newfd);

    [DllImport("libc", EntryPoint = "close")]
    private static extern int Close(int fd);

    [DllImport("libc", EntryPoint = "execv", SetLastError = true)]
    private static extern int Execv([MarshalAs(UnmanagedType.LPUTF8Str)] string file, IntPtr argv);

    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static extern int Kill(int pid, int signal);
}
