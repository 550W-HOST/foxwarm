using System.ComponentModel;
using System.Diagnostics;
using SkiaSharp;
using static Foxwarm.Images.DecoderProtocol;

namespace Foxwarm.Images;

internal sealed class ImageProcessingException(string message) : ImageInputException(message);

internal sealed class ImageDecoderProcess(string executable, Action<string> diagnostic)
{
    internal sealed record Result(
        string Mime,
        int Width,
        int Height,
        SKEncodedOrigin Origin,
        byte[] Bytes
    );

    internal async Task<Result> RunAsync(
        DecodeOperation operation,
        byte[] input,
        string mime,
        bool flag = false,
        int x = 0,
        int y = 0,
        int width = 0,
        int height = 0,
        CancellationToken token = default
    )
    {
        int mimeCode = Array.IndexOf(Mimes, mime);
        if (input.Length > MaxBytes || mimeCode < 0 || !OperatingSystem.IsLinux())
            throw Failure("unsupported request or encoded input limit");
        var start = new ProcessStartInfo("/usr/bin/prlimit")
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true, // never log or parse arbitrary worker diagnostics
            WorkingDirectory = "/",
            ArgumentList =
            {
                "--as=1073741824",
                "--cpu=10",
                "--core=0",
                "--",
                executable,
                RasterCodec.IsHeif(mime) ? "heif" : "raster",
            },
        };
        start.Environment.Clear();
        // Both directories are controlled by the installation. In particular, never inherit the
        // host's loader paths, profiler settings, temporary directories or deployment credentials.
        start.Environment["LD_LIBRARY_PATH"] = Path.GetDirectoryName(executable)!;
        start.Environment["DOTNET_GCHeapHardLimit"] = "18000000"; // hex: 384 MiB within the 1 GiB AS limit
        start.Environment["DOTNET_EnableDiagnostics"] = "0";
        start.Environment["DOTNET_PROCESSOR_COUNT"] = "1";
        token.ThrowIfCancellationRequested();
        using var process = new Process { StartInfo = start };
        try
        {
            process.Start();
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException)
        {
            throw Failure("worker could not start");
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        // Killing the process closes both pipes even when a compromised worker stops reading a
        // large request or stops halfway through a response. The admission slot outlives reaping.
        void Kill()
        {
            try
            {
                process.Kill();
            }
            catch (InvalidOperationException) { }
        }
        using var interrupt = deadline.Token.Register(Kill);
        try
        {
            var writer = process.StandardInput.BaseStream;
            await writer.WriteAsync(
                Header((int)operation, mimeCode, input.Length, flag ? 1 : 0, x, y, width, height),
                deadline.Token
            );
            await writer.WriteAsync(input, deadline.Token);
            writer.Close();
            var reader = process.StandardOutput.BaseStream;
            var h = new byte[ReplySize];
            await reader.ReadExactlyAsync(h, deadline.Token);
            int status = Read(h, 0),
                m = Read(h, 1),
                w = Read(h, 2),
                ht = Read(h, 3),
                origin = Read(h, 4),
                n = Read(h, 5);
            bool dimensions = w > 0 && ht > 0;
            bool limited = dimensions && (long)w * ht <= HeifDecoder.MaxPixels;
            bool valid = status switch
            {
                Bounds => operation == DecodeOperation.Crop
                    && limited
                    && m == 0
                    && origin == 0
                    && n == 0,
                >= Refused => status < FirstError + Errors.Length
                    && m == 0
                    && w == 0
                    && ht == 0
                    && origin == 0
                    && n == 0,
                Ok => operation switch
                {
                    DecodeOperation.Probe => m == mimeCode
                        && dimensions
                        && (!flag || limited)
                        && n == 0
                        && (RasterCodec.IsHeif(mime) ? origin == 0 : origin is >= 1 and <= 8),
                    DecodeOperation.Identify => m is >= 0 and <= 4
                        && w == 0
                        && ht == 0
                        && origin == 0
                        && n == 0,
                    DecodeOperation.ValidateHeif or DecodeOperation.RequireHeif => m == mimeCode
                        && w == 0
                        && ht == 0
                        && origin == 0
                        && n == 0,
                    DecodeOperation.Crop => m is 1 or 2 or 4
                        && w == width
                        && ht == height
                        && limited
                        && origin == 0
                        && n is > 0 and <= MaxBytes,
                    DecodeOperation.Optimize => m is >= 1 and <= 4
                        && limited
                        && origin == 0
                        && (n is > 0 and <= MaxBytes || n == -1 && m == mimeCode),
                    _ => false,
                },
                _ => false,
            };
            if (!valid)
                throw new InvalidDataException();
            var bytes =
                n == -1 ? input
                : n == 0 ? []
                : new byte[n];
            if (n > 0)
                await reader.ReadExactlyAsync(bytes, deadline.Token);
            if (await reader.ReadAsync(h.AsMemory(0, 1), deadline.Token) != 0)
                throw new InvalidDataException();
            await process.WaitForExitAsync(deadline.Token);
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0)
                throw Failure(ExitCause(process.ExitCode));
            if (status == Bounds)
                throw new RasterCrop.Outside(w, ht);
            if (status == Refused)
                throw Failure("codec refused operation");
            if (status >= FirstError)
            {
                int i = status - FirstError;
                throw new ImageInputException(Errors[i]) { InvalidRaster = i < 3 };
            }
            return new(Mimes[m], w, ht, (SKEncodedOrigin)origin, bytes);
        }
        catch (RasterCrop.Outside bounds)
        {
            throw bounds.ForRectangle(x, y, width, height);
        }
        catch (Exception e)
            when (e is not ImageInputException
                && e is (IOException or OperationCanceledException or InvalidDataException)
            )
        {
            token.ThrowIfCancellationRequested();
            if (deadline.IsCancellationRequested)
                throw Failure("wall time limit");
            // EOF can precede delivery of the exit notification. Wait briefly for a natural
            // exit to distinguish a native signal from malformed/truncated stdout.
            throw Failure(
                e is not InvalidDataException && process.WaitForExit(100) && process.ExitCode != 0
                    ? ExitCause(process.ExitCode)
                    : "malformed or incomplete reply"
            );
        }
        finally
        {
            Kill();
            await process.WaitForExitAsync();
        }
    }

    private ImageProcessingException Failure(string cause)
    {
        diagnostic("Image decoder: " + cause + ".");
        return new(Failed);
    }

    private static string ExitCause(int code) =>
        code switch
        {
            3 => "sandbox unavailable",
            4 => "resource limit or worker failure",
            137 => "SIGKILL (CPU ceiling or external kill)",
            139 => "SIGSEGV",
            152 => "CPU limit (SIGXCPU)",
            159 => "seccomp violation (SIGSYS)",
            _ => $"worker exited with status {code}",
        };
}
