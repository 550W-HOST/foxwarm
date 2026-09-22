using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Foxwarm.OpenAIResponses.Client.Tests;

internal sealed record CapturedHttpRequest(string RequestLine, IReadOnlyDictionary<string, string> Headers, string Body);

internal sealed class LoopbackResponsesServer : IAsyncDisposable
{
    private readonly TcpListener listener;
    private readonly Func<NetworkStream, CapturedHttpRequest, Task> respond;
    private readonly Task serverTask;
    private readonly TaskCompletionSource<CapturedHttpRequest> request = NewSignal<CapturedHttpRequest>();
    private int requestCount;

    public LoopbackResponsesServer(Func<NetworkStream, CapturedHttpRequest, Task> respond)
    {
        this.respond = respond;
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        BaseUri = new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/v1");
        serverTask = RunAsync();
    }

    public Uri BaseUri { get; }
    public Task<CapturedHttpRequest> Request => request.Task;
    public int RequestCount => Volatile.Read(ref requestCount);

    private async Task RunAsync()
    {
        try
        {
            using var client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
            Interlocked.Increment(ref requestCount);
            await using var stream = client.GetStream();
            var captured = await ReadRequestAsync(stream).ConfigureAwait(false);
            request.TrySetResult(captured);
            await respond(stream, captured).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            request.TrySetException(error);
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        listener.Stop();
        try { await serverTask.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false); }
        catch (Exception) when (serverTask.IsFaulted || serverTask.IsCanceled) { }
    }

    public static async Task WriteResponseAsync(NetworkStream stream, int status, string contentType, byte[] body, params int[] chunks)
    {
        var reason = status == 200 ? "OK" : "Error";
        var header = $"HTTP/1.1 {status} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(header)).ConfigureAwait(false);
        var offset = 0;
        foreach (var requested in chunks)
        {
            if (offset >= body.Length) break;
            var count = Math.Min(requested, body.Length - offset);
            await stream.WriteAsync(body.AsMemory(offset, count)).ConfigureAwait(false);
            await stream.FlushAsync().ConfigureAwait(false);
            offset += count;
        }
        if (offset < body.Length) await stream.WriteAsync(body.AsMemory(offset)).ConfigureAwait(false);
    }

    private static async Task<CapturedHttpRequest> ReadRequestAsync(NetworkStream stream)
    {
        using var bytes = new MemoryStream();
        var buffer = new byte[1024];
        var headerEnd = -1;
        while (headerEnd < 0)
        {
            var read = await stream.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException("HTTP request ended before headers.");
            bytes.Write(buffer, 0, read);
            headerEnd = Find(bytes.GetBuffer().AsSpan(0, (int)bytes.Length), "\r\n\r\n"u8);
        }
        var all = bytes.ToArray();
        var headerText = Encoding.ASCII.GetString(all, 0, headerEnd);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        var headers = lines.Skip(1)
            .Select(line => line.Split(':', 2))
            .Where(parts => parts.Length == 2)
            .ToDictionary(parts => parts[0], parts => parts[1].Trim(), StringComparer.OrdinalIgnoreCase);
        var contentLength = headers.TryGetValue("Content-Length", out var rawLength) ? int.Parse(rawLength) : 0;
        var bodyOffset = headerEnd + 4;
        while (bytes.Length - bodyOffset < contentLength)
        {
            var read = await stream.ReadAsync(buffer).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException("HTTP request ended before body.");
            bytes.Write(buffer, 0, read);
        }
        all = bytes.ToArray();
        return new CapturedHttpRequest(lines[0], headers, Encoding.UTF8.GetString(all, bodyOffset, contentLength));
    }

    private static int Find(ReadOnlySpan<byte> source, ReadOnlySpan<byte> pattern)
    {
        for (var index = 0; index <= source.Length - pattern.Length; index++)
            if (source.Slice(index, pattern.Length).SequenceEqual(pattern)) return index;
        return -1;
    }

    private static TaskCompletionSource<T> NewSignal<T>() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
