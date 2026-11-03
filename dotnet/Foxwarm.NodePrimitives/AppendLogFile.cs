using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tools;

internal static class AppendLogFile
{
    // FileMode.Append retains a managed position; another process can append
    // beyond it. Native append rights keep every actual write at the current EOF.
    internal static FileStream Open(string path)
    {
        SafeFileHandle handle;
        if (OperatingSystem.IsLinux())
            handle = new SafeFileHandle((IntPtr)OpenUnix(path, 0x80441, 0x1b6), ownsHandle: true);
        else if (OperatingSystem.IsMacOS())
            // Darwin O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC (not Linux flag values).
            handle = new SafeFileHandle(
                (IntPtr)(RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                    // Darwin arm64 variadic arguments start on the stack after x0-x7.
                    ? OpenDarwinArm64(path, 0x01000209, 0, 0, 0, 0, 0, 0, 0x1b6)
                    : OpenUnix(path, 0x01000209, 0x1b6)),
                ownsHandle: true
            );
        else if (OperatingSystem.IsWindows())
            handle = CreateFile(path, 4, 7, IntPtr.Zero, 4, 0x80, IntPtr.Zero);
        else
            throw new PlatformNotSupportedException(
                "Main file logging is supported on Linux, macOS and Windows."
            );
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new IOException(new Win32Exception(error).Message);
        }
        try
        {
            return OperatingSystem.IsMacOS()
                ? new DarwinAppendStream(handle)
                : new FileStream(handle, FileAccess.Write, 1, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    // FileStream uses positioned writes on Unix. Darwin pwrite ignores O_APPEND,
    // unlike Linux, so the shared producer must use write(2), not a cached offset.
    private sealed class DarwinAppendStream(SafeFileHandle handle)
        : FileStream(handle, FileAccess.Write, 1, isAsync: false)
    {
        public override void Write(byte[] buffer, int offset, int count) =>
            Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            ObjectDisposedException.ThrowIf(SafeFileHandle.IsClosed, this);
            if (buffer.IsEmpty) return;
            var bytes = buffer.ToArray();
            var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                var offset = 0;
                while (offset < bytes.Length)
                {
                    var written = WriteDarwin(SafeFileHandle,
                        pinned.AddrOfPinnedObject() + offset, (nuint)(bytes.Length - offset));
                    if (written < 0)
                    {
                        var error = Marshal.GetLastPInvokeError();
                        if (error == 4) continue; // EINTR; no bytes were written.
                        throw new IOException(new Win32Exception(error).Message);
                    }
                    if (written == 0) throw new IOException("Log append made no progress.");
                    offset += checked((int)written);
                }
            }
            finally { pinned.Free(); }
        }

        public override void WriteByte(byte value) => Write(new ReadOnlySpan<byte>([value]));

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token)
            => WriteAsync(buffer.AsMemory(offset, count), token).AsTask();

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default)
        {
            if (token.IsCancellationRequested) return ValueTask.FromCanceled(token);
            try { Write(buffer.Span); return ValueTask.CompletedTask; }
            catch (Exception error) { return ValueTask.FromException(error); }
        }
    }

    [DllImport("libc", EntryPoint = "write", SetLastError = true)]
    private static extern nint WriteDarwin(SafeFileHandle handle, IntPtr buffer, nuint count);

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenDarwinArm64(
        string path, int flags,
        nint unused2, nint unused3, nint unused4, nint unused5, nint unused6, nint unused7,
        uint mode
    );

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenUnix(string path, int flags, uint mode);

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
        IntPtr security,
        uint creation,
        uint attributes,
        IntPtr template
    );
}
