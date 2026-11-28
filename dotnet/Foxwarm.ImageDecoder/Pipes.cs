using System.Runtime.InteropServices;

namespace Foxwarm.ImageDecoder;

// Use the specified descriptor itself. Console.OpenStandardInput/Output may duplicate it.
internal static partial class Pipes
{
    [LibraryImport("libc", SetLastError = true)]
    private static unsafe partial nint read(int fd, byte* buffer, nuint count);

    [LibraryImport("libc", SetLastError = true)]
    private static unsafe partial nint write(int fd, byte* buffer, nuint count);

    internal static unsafe void Transfer(byte[] bytes, bool input)
    {
        fixed (byte* start = bytes)
        {
            int offset = 0;
            while (offset < bytes.Length)
            {
                nuint remaining = (nuint)(bytes.Length - offset);
                var n = input
                    ? read(0, start + offset, remaining)
                    : write(1, start + offset, remaining);
                if (n < 0 && Marshal.GetLastPInvokeError() == 4)
                    continue;
                if (n <= 0)
                    throw new IOException();
                offset += (int)n;
            }
        }
    }
}
