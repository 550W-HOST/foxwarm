using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    private readonly ConcurrentDictionary<string, FileInvocation> transfers = new(
        StringComparer.Ordinal
    );

    private sealed record FileInvocation(
        Connection Connection,
        string ResponseType,
        TaskCompletionSource<JsonObject> Result
    );

    internal sealed record TransferFile(
        byte[] Bytes,
        string Path,
        string Name,
        string? MimeType = null
    );

    internal async Task<TransferFile> ReadFileAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        Action<long>? beforeMaterialize = null,
        string? sessionCwd = null
    )
    {
        using var admission = owner.Entry.AdmitMutation();
        var charged = false;
        void Charge(long length)
        {
            beforeMaterialize?.Invoke(length);
            charged = true;
        }
        await using var source = await OpenReadStreamAsync(
            node,
            path,
            owner,
            restrict,
            token,
            Charge,
            sessionCwd
        );
        if (!charged)
            Charge(source.Length);
        if (source.Length > int.MaxValue)
            throw new IOException("File exceeds the materialization limit.");
        var bytes = new byte[(int)source.Length];
        await source.Stream.ReadExactlyAsync(bytes, token);
        var extra = new byte[1];
        if (await source.Stream.ReadAsync(extra, token) != 0)
            throw new IOException("Source changed or transfer was interrupted.");
        return new(bytes, source.Path, source.Name, source.MimeType);
    }

    private async Task<TransferFile> ReadFileLegacyAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        Action<long>? beforeMaterialize = null,
        string? sessionCwd = null
    )
    {
        var response = await TransferAsync(
            node,
            path,
            owner,
            restrict,
            null,
            false,
            token,
            sessionCwd: sessionCwd
        );
        return DecodeReadResponse(response, path, beforeMaterialize);
    }

    private static TransferFile DecodeReadResponse(
        JsonObject response,
        string path,
        Action<long>? beforeMaterialize = null
    )
    {
        var file =
            response["file"] as JsonObject
            ?? throw new InvalidDataException("Node file response is missing file data.");
        var encoded =
            SessionWait.Text(file["dataBase64"])
            ?? throw new InvalidDataException("Node file response is missing base64 data.");
        var decodedLength =
            encoded.Length / 4 * 3
            - (
                encoded.EndsWith("==", StringComparison.Ordinal) ? 2
                : encoded.EndsWith('=') ? 1
                : 0
            );
        if (encoded.Length % 4 != 0 || SessionWait.Number(file["sizeBytes"]) != decodedLength)
            throw new InvalidDataException("Node file size is invalid.");
        // Charge the encoded payload's actual materialization, not an untrusted reported size.
        beforeMaterialize?.Invoke(decodedLength);
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException error)
        {
            throw new InvalidDataException("Node file data is not valid base64.", error);
        }
        ValidateIntegrity(file, bytes);
        return new(
            bytes,
            SessionWait.Text(file["filePath"]) ?? path,
            SessionWait.Text(file["name"]) ?? RemoteFileName(path),
            SessionWait.Text(file["mimeType"])
        );
    }

    internal async Task<JsonObject> WriteFileAsync(
        string node,
        string path,
        byte[] bytes,
        bool overwrite,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        string? sessionCwd = null
    )
    {
        using var admission = owner.Entry.AdmitMutation();
        if (bytes.Length < StreamThreshold || !StreamingAvailable(node))
            return await WriteFileLegacyAsync(
                node,
                path,
                bytes,
                overwrite,
                owner,
                restrict,
                token,
                sessionCwd: sessionCwd
            );
        using var source = new MemoryStream(bytes, writable: false);
        var result = await WriteStreamAsync(
            node,
            path,
            source,
            bytes.LongLength,
            overwrite,
            owner,
            restrict,
            token,
            sessionCwd: sessionCwd
        );
        return new JsonObject
        {
            ["filePath"] = path,
            ["absolutePath"] = result.Path,
            ["sizeBytes"] = bytes.LongLength,
            ["sha256"] = result.Sha256,
        };
    }

    private async Task<JsonObject> WriteFileLegacyAsync(
        string node,
        string path,
        byte[] bytes,
        bool overwrite,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        bool detachAfterDispatch = false,
        string? sessionCwd = null
    )
    {
        var response = await TransferAsync(
            node,
            path,
            owner,
            restrict,
            bytes,
            overwrite,
            token,
            detachAfterDispatch,
            sessionCwd
        );
        var result =
            response["result"] as JsonObject
            ?? throw new InvalidDataException(
                "Node file response is missing the write result. The write may have occurred; it was not retried."
            );
        ValidateIntegrity(result, bytes);
        return result;
    }

    private static void ValidateIntegrity(JsonObject value, byte[] bytes)
    {
        if (
            SessionWait.Number(value["sizeBytes"]) != bytes.Length
            || !string.Equals(
                SessionWait.Text(value["sha256"]),
                Convert.ToHexStringLower(SHA256.HashData(bytes)),
                StringComparison.Ordinal
            )
        )
            throw new InvalidDataException(
                "Node file transfer size or SHA-256 integrity check failed. Effects were not retried."
            );
    }

    // Sent only when the target is the Session's current Node. A Node that does not know the field
    // keeps resolving relative paths against its Agent directory.
    internal static void AddSessionCwd(JsonObject frame, string? sessionCwd)
    {
        if (!string.IsNullOrWhiteSpace(sessionCwd))
            frame["sessionCwd"] = sessionCwd;
    }

    internal static string RemoteFileName(string path) => path.Replace('\\', '/').Split('/').Last();

    private async Task<JsonObject> TransferAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        byte[]? bytes,
        bool overwrite,
        CancellationToken token,
        bool detachAfterDispatch = false,
        string? sessionCwd = null
    )
    {
        if (
            string.IsNullOrWhiteSpace(path)
            || System.Text.Encoding.UTF8.GetByteCount(path) > 128 * 1024
        )
            throw new InvalidDataException(
                "File transfer requires a nonempty path within 128 KiB of UTF-8 metadata."
            );
        token.ThrowIfCancellationRequested();
        owner.Entry.RequireIdentityAuthority();
        var admission = owner.Entry.AdmitMutation();
        var id = "file_" + Guid.NewGuid().ToString("N");
        Connection connection;
        var result = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var kind = bytes is null ? "read" : "write";
        try
        {
            lock (gate)
            {
                connection = Require(node);
                if (
                    !connection.Capabilities["tools"]!
                        .AsArray()
                        .Any(tool => SessionWait.Text(tool?["name"]) == kind)
                )
                    throw new NotSupportedException(
                        "Node does not advertise file " + kind + ": " + node
                    );
                transfers[id] = new(connection, "file_" + kind + "_response", result);
            }
        }
        catch
        {
            admission?.Dispose();
            throw;
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token, shutdown.Token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        var attempted = false;
        try
        {
            var request = new JsonObject
            {
                ["type"] = "file_" + kind + "_request",
                ["transferId"] = id,
                ["filePath"] = path,
                ["sessionId"] = owner.Id,
                ["agentName"] = owner.Agent,
                ["restrictToAgentDir"] = restrict,
            };
            AddSessionCwd(request, sessionCwd);
            if (bytes is not null)
            {
                request["dataBase64"] = Convert.ToBase64String(bytes);
                request["overwrite"] = overwrite;
            }
            deadline.Token.ThrowIfCancellationRequested();
            lock (gate)
                if (connection.Retired || !ReferenceEquals(Require(node), connection))
                    throw new IOException("Node connection changed before file transfer.");
            attempted = true;
            await SendAsync(connection, request, deadline.Token);
            if (detachAfterDispatch)
            {
                admission?.Dispose();
                admission = null;
            }
            return await result.Task.WaitAsync(deadline.Token);
        }
        catch (System.Net.WebSockets.WebSocketException error)
        {
            throw new IOException(
                "Node disconnected during file transfer. File effects may have occurred; they were not retried.",
                error
            );
        }
        catch (OperationCanceledException) when (attempted && bytes is not null)
        {
            throw new IOException(
                "File write was canceled or timed out after dispatch. The write may have occurred; it was not retried."
            );
        }
        finally
        {
            admission?.Dispose();
            transfers.TryRemove(id, out _);
        }
    }

    private void HandleFileReply(Connection connection, JsonObject message, string type)
    {
        if (HandleStreamingFileReply(connection, message, type))
            return;
        var id = SessionWait.Text(message["transferId"]);
        if (
            id is null
            || !transfers.TryGetValue(id, out var pending)
            || !ReferenceEquals(connection, pending.Connection)
            || type != pending.ResponseType && type != "file_transfer_error"
        )
            return;
        if (!transfers.TryRemove(new KeyValuePair<string, FileInvocation>(id, pending)))
            return;
        if (type == "file_transfer_error")
            pending.Result.TrySetException(
                new IOException(
                    "Node file transfer failed: "
                        + (SessionWait.Text(message["error"]) ?? "unspecified error")
                )
            );
        else
            pending.Result.TrySetResult(message);
    }

    private void FailTransfers(Connection connection, string reason)
    {
        FailStreamingTransfers(connection, reason);
        foreach (var pair in transfers)
            if (
                ReferenceEquals(pair.Value.Connection, connection)
                && transfers.TryRemove(pair.Key, out var transfer)
            )
                transfer.Result.TrySetException(
                    new IOException(
                        reason + ". File effects may have occurred; they were not retried."
                    )
                );
    }
}
