using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tools;

// ProcessStartInfo cannot attach stdout/stderr directly to the same file handle.
// Keep this Windows-only adaptation at the shared native launch boundary, without a managed output pump.
internal static class WindowsExecProcess
{
    internal static int Launch(ProcessStartInfo helper, string outputPath)
    {
        // Only the one-shot helper opens inheritable capture handles. Ordinary BCL
        // children started concurrently in Main or CLI cannot inherit those handles.
        helper.RedirectStandardOutput = true;
        helper.StandardOutputEncoding = new UTF8Encoding(false);
        using var process = Process.Start(helper)
            ?? throw new IOException("Failed to start exec launch helper.");
        using var output = process.StandardOutput;
        string? receipt;
        try
        {
            receipt = output.ReadLineAsync()
                .WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
        }
        catch (Exception error) when (error is IOException or TimeoutException)
        {
            throw new ExecLaunchUncertainException(outputPath, error);
        }
        return Receipt(receipt, outputPath);
    }

    private static int Receipt(string? receipt, string outputPath)
    {
        JsonObject? value;
        try
        {
            value = JsonNode.Parse(receipt ?? "null") as JsonObject;
        }
        catch (System.Text.Json.JsonException error)
        {
            throw new ExecLaunchUncertainException(outputPath, error);
        }
        if (value?["pid"] is JsonValue pid && pid.TryGetValue<int>(out var id) && id > 0)
            return id;
        if (value?["errorCode"] is JsonValue code && code.TryGetValue<int>(out var nativeError))
            throw new Win32Exception(nativeError);
        throw new ExecLaunchUncertainException(outputPath);
    }

    internal static int Helper(string script)
    {
        var start = new ProcessStartInfo("powershell.exe")
        {
            WorkingDirectory = Environment.CurrentDirectory,
        };
        foreach (var argument in new[]
        {
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        })
            start.ArgumentList.Add(argument);
        var output = Environment.GetEnvironmentVariable("FOXWARM_EXEC_LOG_PATH")
            ?? throw new IOException("Missing exec capture path.");
        JsonObject receipt;
        try
        {
            receipt = new JsonObject { ["pid"] = Start(start, output) };
        }
        catch (Win32Exception error)
        {
            // Start throws a Win32Exception only before successful PowerShell creation.
            receipt = new JsonObject { ["errorCode"] = error.NativeErrorCode };
        }
        // Do not include the launch-receipt stream in PowerShell's handle list.
        // The helper exits immediately; disposing it never terminates the command.
        using var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        writer.WriteLine(receipt.ToJsonString());
        return 0;
    }

    private static int Start(ProcessStartInfo start, string outputPath)
    {
        var security = new SecurityAttributes
        {
            Size = Marshal.SizeOf<SecurityAttributes>(),
            Inherit = 1,
        };
        using var output = CreateFile(
            outputPath,
            0x40000000,
            7,
            ref security,
            1,
            0x80,
            IntPtr.Zero
        );
        if (output.IsInvalid)
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        using var input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
        if (input.IsInvalid)
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        IntPtr attributes = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        var attributesInitialized = false;
        try
        {
            nuint size = 0;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size));
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            attributesInitialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 2);
            Marshal.WriteIntPtr(handles, input.DangerousGetHandle());
            Marshal.WriteIntPtr(handles, IntPtr.Size, output.DangerousGetHandle());
            // Exclude the helper's launch-receipt stream and any inherited caller
            // handles; PowerShell receives only its own capture and NUL handles.
            if (
                !UpdateProcThreadAttribute(
                    attributes,
                    0,
                    (IntPtr)0x00020002,
                    handles,
                    (nuint)(IntPtr.Size * 2),
                    IntPtr.Zero,
                    IntPtr.Zero
                )
            )
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            var info = new StartupInfoEx
            {
                Startup = new StartupInfo
                {
                    Size = Marshal.SizeOf<StartupInfoEx>(),
                    Flags = 0x100,
                    Input = input.DangerousGetHandle(),
                    Output = output.DangerousGetHandle(),
                    Error = output.DangerousGetHandle(),
                },
                Attributes = attributes,
            };
            environment = Marshal.StringToHGlobalUni(
                string.Join(
                    '\0',
                    start
                        .Environment.Where(pair => pair.Value is not null)
                        .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                        .Select(pair => pair.Key + "=" + pair.Value)
                ) + "\0\0"
            );
            var command = new StringBuilder(
                string.Join(" ", new[] { start.FileName }.Concat(start.ArgumentList).Select(Quote))
            );
            if (
                !CreateProcess(
                    null,
                    command,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    0x08000400 | 0x00080000,
                    environment,
                    start.WorkingDirectory,
                    ref info,
                    out var process
                )
            )
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            CloseHandle(process.Thread);
            CloseHandle(process.Process);
            return process.Id;
        }
        finally
        {
            if (environment != IntPtr.Zero)
                Marshal.FreeHGlobal(environment);
            if (attributes != IntPtr.Zero)
            {
                if (attributesInitialized)
                    DeleteProcThreadAttributeList(attributes);
                Marshal.FreeHGlobal(attributes);
            }
            if (handles != IntPtr.Zero)
                Marshal.FreeHGlobal(handles);
        }
    }

    private static string Quote(string value)
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
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Size;
        internal IntPtr Descriptor;
        internal int Inherit;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal int Size;
        internal string? Reserved,
            Desktop,
            Title;
        internal int X,
            Y,
            Width,
            Height,
            XChars,
            YChars,
            Fill,
            Flags;
        internal short Show,
            ReservedSize;
        internal IntPtr ReservedBytes,
            Input,
            Output,
            Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        internal StartupInfo Startup;
        internal IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        internal IntPtr Process,
            Thread;
        internal int Id,
            ThreadId;
    }

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern SafeFileHandle CreateFile(
        string path,
        uint access,
        uint share,
        ref SecurityAttributes security,
        uint disposition,
        uint flags,
        IntPtr template
    );

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateProcessW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string? application,
        StringBuilder command,
        IntPtr processSecurity,
        IntPtr threadSecurity,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint flags,
        IntPtr environment,
        string cwd,
        ref StartupInfoEx startup,
        out ProcessInfo process
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributes,
        int count,
        uint flags,
        ref nuint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributes,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        nuint size,
        IntPtr previous,
        IntPtr returned
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}

internal sealed class ExecLaunchUncertainException(string outputPath, Exception? inner = null)
    : IOException(
        "Command launch outcome is uncertain. Do not retry automatically; inspect the execution artifacts."
            + "\nLog: " + outputPath
            + "\nStatus: " + outputPath + ".exit.json"
            + "\nWorking directory: " + outputPath + ".cwd.txt",
        inner
    );
