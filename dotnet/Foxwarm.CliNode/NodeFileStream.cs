using System.ComponentModel;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.CliNode;

internal sealed class NodeFileStream(NodePaths paths, string host, string nodeId, string authToken)
{
    private const int Threshold = 64 * 1024;
    private static readonly TimeSpan NoProgress = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ResponseTimeout = TimeSpan.FromSeconds(30);

    private static void RequireSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException(
                $"File transfer endpoint returned HTTP {(int)response.StatusCode}.",
                null,
                response.StatusCode
            );
    }

    private (HttpClient Client, HttpRequestMessage Request) Request(
        string transferId,
        HttpMethod method
    )
    {
        var uri = new Uri(host.TrimEnd('/') + "/node/transfer/" + Uri.EscapeDataString(transferId));
        var proxy = MasterProxy.Create(uri);
        var client = new HttpClient(
            new HttpClientHandler { Proxy = proxy, UseProxy = proxy is not null }
        )
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Add("X-Foxwarm-Node", nodeId);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", authToken);
        return (client, request);
    }

    internal async Task<JsonObject?> Read(
        string id,
        string raw,
        string agent,
        bool restrict,
        CancellationToken token
    )
    {
        var path = paths.Transfer(raw, agent, restrict);
        await using var input = OpenSource(path, raw);
        var length = input.Length;
        if (length < Threshold)
        {
            var bytes = new byte[(int)length];
            await input.ReadExactlyAsync(bytes, token);
            var metadataPath = raw.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
            var (mime, image) = NodeFileTransfer.Mime(metadataPath);
            return new JsonObject
            {
                ["filePath"] = raw,
                ["name"] = Path.GetFileName(metadataPath),
                ["sizeBytes"] = length,
                ["mimeType"] = mime,
                ["isImage"] = image,
                ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
                ["dataBase64"] = Convert.ToBase64String(bytes),
            };
        }
        var (client, request) = Request(id, HttpMethod.Put);
        using (client)
        using (request)
        using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token))
        {
            deadline.CancelAfter(NoProgress);
            var content = new SourceContent(input, length, deadline);
            request.Content = content;
            try
            {
                using var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    deadline.Token
                );
                RequireSuccess(response);
            }
            catch (OperationCanceledException error)
                when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
            {
                throw new TimeoutException(
                    content.Uploaded
                        ? "File transfer endpoint did not respond within 30 seconds."
                        : "File transfer made no progress for 60 seconds.",
                    error
                );
            }
        }
        return null;
    }

    internal static FileStream OpenSource(string path, string raw)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            if (NativeFileKind.Read(path) != "file")
                throw new InvalidDataException("Not a file: " + raw);
            var input = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                65536,
                FileOptions.Asynchronous | FileOptions.SequentialScan
            );
            try
            {
                if (OperatingSystem.IsWindows())
                    _ = OpenFileMetadata.Read(input.SafeFileHandle, "Not a file: " + raw);
                return input;
            }
            catch
            {
                input.Dispose();
                throw;
            }
        }
        // A path may become a FIFO between a path stat and open. Nonblocking open lets us
        // inspect the opened object without tying up a worker when no FIFO writer exists.
        const int LinuxNonblockingCloseOnExec = 0x800 | 0x80000;
        const int DarwinNonblockingCloseOnExec = 0x4 | 0x1000000;
        var flags = OperatingSystem.IsLinux()
            ? LinuxNonblockingCloseOnExec
            : DarwinNonblockingCloseOnExec;
        var descriptor = Open(path, flags);
        if (descriptor < 0)
        {
            var error = Marshal.GetLastPInvokeError();
            throw new IOException(
                new Win32Exception(error).Message + ": " + raw,
                unchecked((int)0x80070000) | error
            );
        }
        var handle = new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
        try
        {
            _ = OpenFileMetadata.Read(handle, "Not a file: " + raw);
            return new FileStream(handle, FileAccess.Read, 65536, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open(string path, int flags);

    internal async Task<JsonObject> Write(
        string id,
        string raw,
        string agent,
        bool restrict,
        bool overwrite,
        long length,
        CancellationToken token
    )
    {
        if (length < 0)
            throw new InvalidDataException("Invalid file transfer size.");
        var path = paths.Transfer(raw, agent, restrict);
        var existed = NodeFileTools.Exists(path);
        if (existed && !overwrite)
            throw new InvalidDataException(
                $"File already exists: {raw}. Use overwrite=true to replace it."
            );
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary =
            path
            + "."
            + Environment.ProcessId
            + "."
            + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6))
            + ".tmp";
        try
        {
            var (client, request) = Request(id, HttpMethod.Get);
            using (client)
            using (request)
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                deadline.CancelAfter(ResponseTimeout);
                HttpResponseMessage received;
                try
                {
                    received = await client.SendAsync(
                        request,
                        HttpCompletionOption.ResponseHeadersRead,
                        deadline.Token
                    );
                }
                catch (OperationCanceledException error)
                    when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
                {
                    throw new TimeoutException(
                        "File transfer endpoint did not respond within 30 seconds.",
                        error
                    );
                }
                using var response = received;
                RequireSuccess(response);
                deadline.CancelAfter(NoProgress);
                if (response.Content.Headers.ContentLength != length)
                    throw new InvalidDataException("File transfer size is invalid.");
                await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                long total = 0;
                await using (
                    var output = new FileStream(
                        temporary,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        65536,
                        FileOptions.Asynchronous
                    )
                )
                {
                    var buffer = new byte[65536];
                    int count;
                    while ((count = await input.ReadAsync(buffer, deadline.Token)) != 0)
                    {
                        if (count > length - total)
                            throw new IOException("File transfer exceeded its declared size.");
                        hash.AppendData(buffer, 0, count);
                        await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token);
                        total += count;
                        deadline.CancelAfter(NoProgress);
                    }
                }
                if (total != length)
                    throw new IOException("Source changed or transfer was interrupted.");
                deadline.Token.ThrowIfCancellationRequested();
                File.Move(temporary, path, overwrite);
                return new JsonObject
                {
                    ["filePath"] = raw,
                    ["absolutePath"] = path,
                    ["sizeBytes"] = total,
                    ["sha256"] = Convert.ToHexStringLower(hash.GetHashAndReset()),
                    ["overwritten"] = existed,
                };
            }
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private sealed class SourceContent(Stream input, long length, CancellationTokenSource deadline)
        : HttpContent
    {
        private int uploaded;
        internal bool Uploaded => Volatile.Read(ref uploaded) != 0;

        protected override bool TryComputeLength(out long size)
        {
            size = length;
            return true;
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeToStreamAsync(stream, context, deadline.Token);

        protected override async Task SerializeToStreamAsync(
            Stream stream,
            TransportContext? context,
            CancellationToken cancellationToken
        )
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                deadline.Token
            );
            var buffer = new byte[65536];
            long remaining = length;
            while (remaining > 0)
            {
                var read = await input.ReadAsync(
                    buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)),
                    linked.Token
                );
                if (read == 0)
                    throw new IOException("Source changed or transfer was interrupted.");
                await stream.WriteAsync(buffer.AsMemory(0, read), linked.Token);
                remaining -= read;
                deadline.CancelAfter(NoProgress);
            }
            Volatile.Write(ref uploaded, 1);
            deadline.CancelAfter(ResponseTimeout);
        }
    }
}
