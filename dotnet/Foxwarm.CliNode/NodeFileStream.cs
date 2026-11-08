using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed class NodeFileStream(NodePaths paths, string host, string nodeId, string authToken)
{
    private const int Threshold = 64 * 1024;
    private static readonly TimeSpan NoProgress = TimeSpan.FromSeconds(60);

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
        if (NativeFileKind.Read(path) != "file")
            throw new InvalidDataException("Not a file: " + raw);
        await using var input = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            65536,
            FileOptions.Asynchronous | FileOptions.SequentialScan
        );
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
            request.Content = new SourceContent(input, length, deadline);
            using var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                deadline.Token
            );
            response.EnsureSuccessStatusCode();
        }
        return null;
    }

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
                deadline.CancelAfter(NoProgress);
                using var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    deadline.Token
                );
                response.EnsureSuccessStatusCode();
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
        }
    }
}
