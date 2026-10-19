using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Foxwarm.Nodes;

internal sealed partial class ExecutableNodeProvider
{
    private async Task<string> RunChildAsync(byte[] input, int stdoutLimit, int deadlineSeconds, CancellationToken token)
    {
        using var child = new Process();
        child.StartInfo = new ProcessStartInfo(command)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        child.StartInfo.Environment.Clear();
        foreach (var key in EnvironmentKeys)
            if (Environment.GetEnvironmentVariable(key) is string value)
                child.StartInfo.Environment[key] = value;
        foreach (var argument in arguments) child.StartInfo.ArgumentList.Add(argument);
        try { child.Start(); }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException)
        {
            throw new NodeProviderException("NODE_PROVIDER_PROCESS_START", "Provider executable failed to start.", true);
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(deadlineSeconds));
        var signal = deadline.Token;
        async Task<byte[]> ReadBounded(Stream source, int limit, string code)
        {
            using var output = new MemoryStream();
            var bytes = new byte[16384];
            int count;
            while ((count = await source.ReadAsync(bytes, signal)) != 0)
            {
                if (output.Length + count > limit)
                    throw new NodeProviderException(code, "Provider output exceeded its byte limit.");
                output.Write(bytes, 0, count);
            }
            return output.ToArray();
        }
        async Task WriteInput()
        {
            try { await child.StandardInput.BaseStream.WriteAsync(input, signal); }
            catch (IOException) { /* Exit/response determines whether the closed stdin was an error. */ }
            finally { child.StandardInput.Close(); }
        }
        var stdout = ReadBounded(child.StandardOutput.BaseStream, stdoutLimit, "NODE_PROVIDER_OUTPUT_LIMIT");
        var stderr = ReadBounded(child.StandardError.BaseStream, 64 * 1024, "NODE_PROVIDER_STDERR_LIMIT");
        var stdin = WriteInput();
        var exited = child.WaitForExitAsync();
        var tasks = new Task[] { stdout, stderr, stdin, exited };
        try
        {
            // Fail promptly if either stream faults; WhenAll alone would wait for a blocked child.
            var remaining = tasks.ToList();
            while (remaining.Count > 0)
            {
                var finished = await Task.WhenAny(remaining).WaitAsync(signal);
                await finished;
                remaining.Remove(finished);
            }
            if (child.ExitCode != 0)
                throw new NodeProviderException("NODE_PROVIDER_PROCESS_EXIT", "Provider executable exited abnormally.", true);
            return Encoding.UTF8.GetString(await stdout);
        }
        catch (Exception error)
        {
            var closedWithoutStdio = child.HasExited && !token.IsCancellationRequested && error is OperationCanceledException;
            await TerminateAsync(child);
            if (error is NodeProviderException) throw;
            if (error is OperationCanceledException)
                throw new NodeProviderException(
                    token.IsCancellationRequested ? "NODE_PROVIDER_CANCELLED" : closedWithoutStdio ? "NODE_PROVIDER_PROCESS_CLOSE_TIMEOUT" : "NODE_PROVIDER_TIMEOUT",
                    token.IsCancellationRequested ? "Provider request was cancelled." : closedWithoutStdio ? "Provider exited without closing its owned stdio." : "Provider request exceeded its deadline.", true);
            throw new NodeProviderException("NODE_PROVIDER_PROCESS_IO", "Provider process transport failed.", true);
        }
        finally
        {
            deadline.Cancel();
            child.StandardInput.Dispose();
            child.StandardOutput.Dispose();
            child.StandardError.Dispose();
            foreach (var task in tasks)
                _ = task.ContinueWith(completed => _ = completed.Exception, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
        }
    }

    private static async Task TerminateAsync(Process child)
    {
        if (child.HasExited) return;
        try
        {
            if (OperatingSystem.IsWindows()) child.CloseMainWindow();
            else _ = Kill(child.Id, 15);
        }
        catch (InvalidOperationException) { }
        await Task.WhenAny(child.WaitForExitAsync(), Task.Delay(250));
        if (child.HasExited) return;
        try { child.Kill(entireProcessTree: false); }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
        await Task.WhenAny(child.WaitForExitAsync(), Task.Delay(2000));
        if (!child.HasExited)
            throw new NodeProviderException("NODE_PROVIDER_PROCESS_EXIT_UNCONFIRMED", "Provider child exit was not confirmed.");
    }

    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static extern int Kill(int pid, int signal);
}
