using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    internal const int FileLimit = 50 * 1024 * 1024;

    // Base64 of a supported file plus bounded metadata, including extended Windows paths.
    internal const int FileFrameLimit = 4 * ((FileLimit + 2) / 3) + 1024 * 1024;
    private readonly ConcurrentDictionary<string, FileInvocation> transfers = new(
        StringComparer.Ordinal
    );

    private sealed record FileInvocation(
        Connection Connection,
        string ResponseType,
        TaskCompletionSource<JsonObject> Result
    );

    internal sealed record TransferFile(byte[] Bytes, string Path, string Name, string? MimeType = null);

    internal async Task<TransferFile> ReadFileAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        var response = await TransferAsync(node, path, owner, restrict, null, false, token);
        var file =
            response["file"] as JsonObject
            ?? throw new InvalidDataException("Node file response is missing file data.");
        var encoded =
            SessionWait.Text(file["dataBase64"])
            ?? throw new InvalidDataException("Node file response is missing base64 data.");
        if (encoded.Length > 4 * ((FileLimit + 2) / 3))
            throw new InvalidDataException("File exceeds the 50 MiB transfer limit.");
        var decodedLength =
            encoded.Length / 4 * 3
            - (
                encoded.EndsWith("==", StringComparison.Ordinal) ? 2
                : encoded.EndsWith('=') ? 1
                : 0
            );
        if (
            encoded.Length % 4 != 0
            || decodedLength > FileLimit
            || SessionWait.Number(file["sizeBytes"]) != decodedLength
        )
            throw new InvalidDataException(
                "Node file size is invalid or exceeds the transfer limit."
            );
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
        CancellationToken token
    )
    {
        if (bytes.Length > FileLimit)
            throw new InvalidDataException("File exceeds the 50 MiB transfer limit.");
        var response = await TransferAsync(node, path, owner, restrict, bytes, overwrite, token);
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
            bytes.Length > FileLimit
            || SessionWait.Number(value["sizeBytes"]) != bytes.Length
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

    internal static string RemoteFileName(string path) => path.Replace('\\', '/').Split('/').Last();

    private async Task<JsonObject> TransferAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        byte[]? bytes,
        bool overwrite,
        CancellationToken token
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
        using var admission = owner.Entry.AdmitMutation();
        var id = "file_" + Guid.NewGuid().ToString("N");
        Connection connection;
        var result = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var kind = bytes is null ? "read" : "write";
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
            transfers.TryRemove(id, out _);
        }
    }

    private void HandleFileReply(Connection connection, JsonObject message, string type)
    {
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
