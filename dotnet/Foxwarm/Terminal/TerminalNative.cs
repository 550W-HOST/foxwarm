using System.Runtime.InteropServices;
using System.Text;

namespace Foxwarm.Terminal;

internal static class TerminalNative
{
    private const string Library = "foxwarm-pty";
    private static readonly string NativePath = Path.Combine(
        AppContext.BaseDirectory,
        "libfoxwarm-pty.so"
    );
    internal static bool IsSupported => OperatingSystem.IsLinux() && File.Exists(NativePath);

    static TerminalNative()
    {
        NativeLibrary.SetDllImportResolver(
            typeof(TerminalNative).Assembly,
            (name, _, _) =>
                name == Library && File.Exists(NativePath)
                    ? NativeLibrary.Load(NativePath)
                    : IntPtr.Zero
        );
    }

    [DllImport(Library)]
    private static extern IntPtr fw_spawn(
        IntPtr exe,
        IntPtr argv,
        IntPtr env,
        IntPtr cwd,
        ushort cols,
        ushort rows,
        out int error
    );

    [DllImport(Library)]
    private static extern int fw_pid(IntPtr handle);

    [DllImport(Library)]
    private static extern int fw_session(IntPtr handle);

    [DllImport(Library)]
    private static extern int fw_foreground(IntPtr handle);

    [DllImport(Library)]
    private static extern int fw_resize(IntPtr handle, ushort cols, ushort rows);

    [DllImport(Library)]
    private static extern long fw_read(IntPtr handle, [Out] byte[] buffer, nuint count);

    [DllImport(Library)]
    private static extern int fw_write(
        IntPtr handle,
        byte[] buffer,
        nuint count,
        out nuint written
    );

    [DllImport(Library)]
    private static extern void fw_cancel(IntPtr handle);

    [DllImport(Library)]
    private static extern int fw_signal_shell(IntPtr handle, int signal);

    [DllImport(Library)]
    private static extern int fw_signal_foreground(IntPtr handle, int signal);

    [DllImport(Library)]
    private static extern int fw_wait(IntPtr handle, out int code, out int signal);

    [DllImport(Library)]
    private static extern int fw_release(IntPtr handle);

    [DllImport(Library)]
    private static extern int fw_owned_fds();

    internal sealed class Handle : IDisposable
    {
        private IntPtr pointer;
        internal IntPtr Pointer => pointer;
        internal int Pid { get; }
        internal int Session { get; }

        internal Handle(IntPtr pointer)
        {
            this.pointer = pointer;
            Pid = fw_pid(pointer);
            Session = fw_session(pointer);
            if (Session < 0)
                throw new IOException($"PTY controlling session unavailable: errno {-Session}.");
        }

        internal static Handle Spawn(
            string shell,
            IReadOnlyList<string> arguments,
            string cwd,
            IReadOnlyDictionary<string, string> environment,
            int cols,
            int rows
        )
        {
            if (!IsSupported)
                throw new PlatformNotSupportedException(
                    "Main terminal PTY is unavailable on this Linux host."
                );
            var exe = Marshal.StringToCoTaskMemUTF8(shell);
            var directory = Marshal.StringToCoTaskMemUTF8(cwd);
            using var argv = new NativeStrings([shell, .. arguments]);
            using var env = new NativeStrings(
                environment.Select(pair => $"{pair.Key}={pair.Value}")
            );
            var pointer = fw_spawn(
                exe,
                argv.Pointer,
                env.Pointer,
                directory,
                checked((ushort)cols),
                checked((ushort)rows),
                out var error
            );
            Marshal.FreeCoTaskMem(exe);
            Marshal.FreeCoTaskMem(directory);
            if (pointer == IntPtr.Zero)
                throw new IOException($"Unable to start terminal process (errno {error}).");
            try
            {
                return new Handle(pointer);
            }
            catch
            {
                fw_cancel(pointer);
                fw_signal_shell(pointer, 15);
                fw_wait(pointer, out _, out _);
                fw_release(pointer);
                throw;
            }
        }

        internal long Read(byte[] buffer) => fw_read(Pointer, buffer, (nuint)buffer.Length);

        internal void Write(byte[] buffer)
        {
            nuint offset = 0;
            while (offset < (nuint)buffer.Length)
            {
                var error = fw_write(
                    Pointer,
                    buffer.AsSpan((int)offset).ToArray(),
                    (nuint)(buffer.Length - (int)offset),
                    out var written
                );
                offset += written;
                if (error != 0)
                    throw new IOException($"Terminal input failed (errno {error}).");
            }
        }

        internal void Resize(int cols, int rows)
        {
            var error = fw_resize(Pointer, checked((ushort)cols), checked((ushort)rows));
            if (error != 0)
                throw new IOException($"Terminal resize failed (errno {error}).");
        }

        internal int Foreground => fw_foreground(Pointer);

        internal void CancelRead() => fw_cancel(Pointer);

        internal void SignalForeground(int signal)
        {
            var error = fw_signal_foreground(Pointer, signal);
            if (error != 0 && error != 1 && error != 3)
                throw new IOException($"Terminal foreground signal failed (errno {error}).");
        }

        internal void SignalShell(int signal)
        {
            var error = fw_signal_shell(Pointer, signal);
            if (error != 0 && error != 3)
                throw new IOException($"Terminal shell signal failed (errno {error}).");
        }

        internal (int Error, int Code, int Signal) Wait()
        {
            var error = fw_wait(Pointer, out var code, out var signal);
            return (error, code, signal);
        }

        public void Dispose()
        {
            var value = Interlocked.Exchange(ref pointer, IntPtr.Zero);
            if (value != IntPtr.Zero)
            {
                var error = fw_release(value);
                if (error != 0)
                    throw new IOException($"PTY release failed (errno {error}).");
            }
        }

        internal static int OwnedFdCount => fw_owned_fds();
    }

    private sealed class NativeStrings : IDisposable
    {
        private readonly IntPtr[] values;
        internal IntPtr Pointer { get; }

        internal NativeStrings(IEnumerable<string> strings)
        {
            values = strings.Select(Marshal.StringToCoTaskMemUTF8).Append(IntPtr.Zero).ToArray();
            Pointer = Marshal.AllocHGlobal(values.Length * IntPtr.Size);
            Marshal.Copy(values, 0, Pointer, values.Length);
        }

        public void Dispose()
        {
            foreach (var value in values)
                if (value != IntPtr.Zero)
                    Marshal.FreeCoTaskMem(value);
            Marshal.FreeHGlobal(Pointer);
        }
    }
}
