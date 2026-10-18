using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Terminal;

// ConPTY owns only interactive terminal processes, never independent execs.
internal sealed class WindowsPseudoConsole : IDisposable
{
    private IntPtr console;
    private readonly SafeFileHandle process;
    private readonly FileStream output;
    private readonly FileStream input;
    private readonly object closeGate = new();
    private Task? close;
    internal int Pid { get; }

    private WindowsPseudoConsole(IntPtr console, ProcessInformation child, SafeFileHandle read, SafeFileHandle write)
    {
        this.console = console;
        process = new SafeFileHandle(child.Process, true);
        CloseHandle(child.Thread);
        Pid = checked((int)child.ProcessId);
        output = new FileStream(read, FileAccess.Read, 4096, false);
        input = new FileStream(write, FileAccess.Write, 4096, false);
    }

    internal static WindowsPseudoConsole Spawn(string shell, IReadOnlyList<string> arguments, string cwd, IReadOnlyDictionary<string, string> environment, int cols, int rows)
    {
        if (!CreatePipe(out var inputRead, out var inputWrite, IntPtr.Zero, 0))
            throw new Win32Exception();
        using var readEnd = inputRead;
        using var writeEnd = inputWrite;
        if (!CreatePipe(out var outputRead, out var outputWrite, IntPtr.Zero, 0))
            throw new Win32Exception();
        using var readOutput = outputRead;
        using var writeOutput = outputWrite;
        Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord(cols, rows), inputRead, outputWrite, 0, out var console));
        IntPtr attributes = IntPtr.Zero;
        var attributesInitialized = false;
        IntPtr block = IntPtr.Zero;
        try
        {
            nuint size = 0;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size));
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                throw new Win32Exception();
            attributesInitialized = true;
            if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020016, console, (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception();
            // ConPTY supplies console standard handles; do not copy Main's
            // redirected console/pipe handles into the interactive child.
            var startup = new StartupInfoEx { Startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfoEx>(), Flags = 0x00000100 }, Attributes = attributes };
            var command = new StringBuilder(string.Join(" ", new[] { shell }.Concat(arguments).Select(Quote)));
            var variables = string.Join('\0', environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
            block = Marshal.StringToHGlobalUni(variables);
            if (!CreateProcessW(shell, command, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, block, cwd, ref startup, out var child))
                throw new Win32Exception();
            // Transfer only the host-facing pipe ends. The console-side ends close
            // after spawn so EOF describes the actual console lifetime.
            var ownedRead = new SafeFileHandle(readOutput.DangerousGetHandle(), true);
            readOutput.SetHandleAsInvalid();
            var ownedWrite = new SafeFileHandle(writeEnd.DangerousGetHandle(), true);
            writeEnd.SetHandleAsInvalid();
            var result = new WindowsPseudoConsole(console, child, ownedRead, ownedWrite);
            console = IntPtr.Zero;
            return result;
        }
        finally
        {
            if (block != IntPtr.Zero)
                Marshal.FreeHGlobal(block);
            if (attributes != IntPtr.Zero)
            {
                if (attributesInitialized)
                    DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            if (console != IntPtr.Zero)
                ClosePseudoConsole(console);
        }
    }

    // Standard Windows argv quoting (not shell-language quoting).
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    internal long Read(byte[] buffer)
    {
        try
        {
            return output.Read(buffer);
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 109 or 232)
        {
            return 0;
        }
    }

    internal void Write(byte[] buffer)
    {
        input.Write(buffer);
        input.Flush();
    }

    internal void Resize(int cols, int rows) => Marshal.ThrowExceptionForHR(ResizePseudoConsole(console, new Coord(cols, rows)));

    internal void Close()
    {
        lock (closeGate)
        {
            // ClosePseudoConsole may synchronously emit a final frame. Keep the
            // reader draining on its own thread until the output channel closes.
            close ??= Task.Run(() => ClosePseudoConsole(Interlocked.Exchange(ref console, IntPtr.Zero)));
        }
    }

    internal (int Error, int Code, int Signal) Wait()
    {
        if (WaitForSingleObject(process, uint.MaxValue) != 0)
            return (Marshal.GetLastWin32Error(), 0, 0);
        return GetExitCodeProcess(process, out var code)
            ? (0, unchecked((int)code), 0)
            : (Marshal.GetLastWin32Error(), 0, 0);
    }

    public void Dispose()
    {
        Close();
        close!.GetAwaiter().GetResult();
        input.Dispose();
        output.Dispose();
        process.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly struct Coord(int x, int y)
    {
        internal readonly short X = checked((short)x);
        internal readonly short Y = checked((short)y);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        internal int Size;
        internal IntPtr Reserved, Desktop, Title;
        internal int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        internal short ShowWindow, ReservedSize;
        internal IntPtr ReservedData, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        internal StartupInfo Startup;
        internal IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
