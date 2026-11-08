using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    private const int StreamThreshold = 64 * 1024;
    private readonly ConcurrentDictionary<string, StreamInvocation> fileStreams = new(
        StringComparer.Ordinal
    );

    private sealed class StreamInvocation(
        Connection connection,
        bool read,
        CancellationToken token,
        CancellationToken shutdown
    ) : IDisposable
    {
        internal readonly Connection Connection = connection;
        internal readonly bool Read = read;
        internal readonly CancellationTokenSource Stop =
            CancellationTokenSource.CreateLinkedTokenSource(token, shutdown);
        internal readonly TaskCompletionSource<object> Start = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource<JsonObject> Reply = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly TaskCompletionSource<bool> Finished = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal Stream? Input;
        internal long Length;
        internal string? Sha256;
        internal int Claimed;

        internal void Abort(Exception error)
        {
            Start.TrySetException(error);
            Reply.TrySetException(error);
            Finished.TrySetException(error);
            try
            {
                Stop.Cancel();
            }
            catch (ObjectDisposedException) { }
        }

        public void Dispose() => Stop.Dispose();
    }

    private bool StreamingAvailable(string node)
    {
        lock (gate)
        {
            var connection = Require(node);
            return SessionWait.Number(connection.Capabilities["features"]?["fileStream"]) == 1;
        }
    }

    private StreamInvocation BeginFileStream(
        string node,
        string path,
        SessionOwner owner,
        bool read,
        CancellationToken token,
        out string id
    )
    {
        if (string.IsNullOrWhiteSpace(path) || Encoding.UTF8.GetByteCount(path) > 128 * 1024)
            throw new InvalidDataException(
                "File transfer requires a nonempty path within 128 KiB of UTF-8 metadata."
            );
        token.ThrowIfCancellationRequested();
        owner.Entry.RequireIdentityAuthority();
        id = "file_" + Guid.NewGuid().ToString("N");
        lock (gate)
        {
            var connection = Require(node);
            var kind = read ? "read" : "write";
            if (
                !connection.Capabilities["tools"]!
                    .AsArray()
                    .Any(tool => SessionWait.Text(tool?["name"]) == kind)
            )
                throw new NotSupportedException(
                    "Node does not advertise file " + kind + ": " + node
                );
            var invocation = new StreamInvocation(connection, read, token, shutdown.Token);
            fileStreams[id] = invocation;
            return invocation;
        }
    }

    private static JsonObject StreamControl(
        string id,
        string path,
        SessionOwner owner,
        bool restrict,
        bool read
    ) =>
        new()
        {
            ["type"] = read ? "file_stream_read_request" : "file_stream_write_request",
            ["transferId"] = id,
            ["filePath"] = path,
            ["sessionId"] = owner.Id,
            ["agentName"] = owner.Agent,
            ["restrictToAgentDir"] = restrict,
        };

    internal async Task<TransferSource> OpenReadStreamAsync(
        string node,
        string path,
        SessionOwner owner,
        bool restrict,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        if (!StreamingAvailable(node))
        {
            var file = await ReadFileLegacyAsync(
                node,
                path,
                owner,
                restrict,
                token,
                beforeMaterialize
            );
            return new(
                new MemoryStream(file.Bytes, writable: false),
                file.Bytes.LongLength,
                file.Path,
                file.Name,
                file.MimeType
            );
        }
        var invocation = BeginFileStream(node, path, owner, true, token, out var id);
        try
        {
            await SendAsync(
                invocation.Connection,
                StreamControl(id, path, owner, restrict, true),
                token,
                () => RequireCurrentFileConnection(node, invocation.Connection)
            );
            var first = await invocation.Start.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
            if (first is JsonObject inline)
            {
                var file = DecodeReadResponse(inline, path, beforeMaterialize);
                EndFileStream(id, invocation);
                return new(
                    new MemoryStream(file.Bytes, writable: false),
                    file.Bytes.LongLength,
                    file.Path,
                    file.Name,
                    file.MimeType
                );
            }
            var context = (HttpContext)first;
            var length = context.Request.ContentLength!.Value;
            invocation.Stop.CancelAfter(TimeSpan.FromSeconds(60));
            var stream = new IncomingFileStream(this, id, invocation, context, length);
            var name = RemoteFileName(path);
            return new(stream, length, path, name, NodeProviderRegistry.TransferMime(name));
        }
        catch (Exception error)
        {
            invocation.Abort(error);
            EndFileStream(id, invocation);
            throw;
        }
    }

    internal async Task<(string Path, string Sha256)> WriteStreamAsync(
        string node,
        string path,
        Stream input,
        long length,
        bool overwrite,
        SessionOwner owner,
        bool restrict,
        CancellationToken token
    )
    {
        if (length < StreamThreshold || !StreamingAvailable(node))
        {
            using var buffer = new MemoryStream();
            var hash = await TransferStream.CopyAsync(input, buffer, length, token);
            var result = await WriteFileLegacyAsync(
                node,
                path,
                buffer.ToArray(),
                overwrite,
                owner,
                restrict,
                token
            );
            return (
                SessionWait.Text(result["absolutePath"])
                    ?? SessionWait.Text(result["filePath"])
                    ?? path,
                hash
            );
        }
        var invocation = BeginFileStream(node, path, owner, false, token, out var id);
        invocation.Input = input;
        invocation.Length = length;
        try
        {
            var control = StreamControl(id, path, owner, restrict, false);
            control["overwrite"] = overwrite;
            control["sizeBytes"] = length;
            await SendAsync(
                invocation.Connection,
                control,
                token,
                () => RequireCurrentFileConnection(node, invocation.Connection)
            );
            await invocation.Start.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
            await invocation.Finished.Task.WaitAsync(token);
            var reply = await invocation.Reply.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
            var result =
                reply["result"] as JsonObject
                ?? throw new InvalidDataException(
                    "Node file response is missing the write result."
                );
            if (
                SessionWait.Number(result["sizeBytes"]) != length
                || SessionWait.Text(result["sha256"]) != invocation.Sha256
            )
                throw new InvalidDataException(
                    "Node file transfer size or SHA-256 integrity check failed. Effects were not retried."
                );
            return (
                SessionWait.Text(result["absolutePath"])
                    ?? SessionWait.Text(result["filePath"])
                    ?? path,
                invocation.Sha256!
            );
        }
        catch (OperationCanceledException error) when (Volatile.Read(ref invocation.Claimed) == 1)
        {
            invocation.Abort(error);
            throw new OperationCanceledException(
                "File write was canceled after dispatch. The destination may already have been published; it was not retried.",
                error,
                token
            );
        }
        catch (Exception error) when (Volatile.Read(ref invocation.Claimed) == 1)
        {
            invocation.Abort(error);
            throw new IOException(
                "File write failed after dispatch. The destination may already have been published; it was not retried.",
                error
            );
        }
        catch (Exception error)
        {
            invocation.Abort(error);
            throw;
        }
        finally
        {
            EndFileStream(id, invocation);
        }
    }

    private void RequireCurrentFileConnection(string node, Connection connection)
    {
        lock (gate)
            if (connection.Retired || !ReferenceEquals(Require(node), connection))
                throw new IOException("Node connection changed before file transfer.");
    }

    private void EndFileStream(string id, StreamInvocation invocation)
    {
        fileStreams.TryRemove(new KeyValuePair<string, StreamInvocation>(id, invocation));
        invocation.Dispose();
    }

    private bool HandleStreamingFileReply(Connection connection, JsonObject message, string type)
    {
        var id = SessionWait.Text(message["transferId"]);
        if (
            id is null
            || !fileStreams.TryGetValue(id, out var pending)
            || !ReferenceEquals(connection, pending.Connection)
        )
            return false;
        if (type == "file_transfer_error")
        {
            pending.Abort(
                new IOException(
                    "Node file transfer failed: "
                        + (SessionWait.Text(message["error"]) ?? "unspecified error")
                )
            );
            return true;
        }
        if (
            pending.Read
            && type == "file_read_response"
            && Interlocked.CompareExchange(ref pending.Claimed, 2, 0) == 0
        )
            pending.Start.TrySetResult(message);
        else if (!pending.Read && type == "file_write_response")
            pending.Reply.TrySetResult(message);
        return true;
    }

    private void FailStreamingTransfers(Connection connection, string reason)
    {
        foreach (var pending in fileStreams.Values)
            if (ReferenceEquals(pending.Connection, connection))
                pending.Abort(
                    new IOException(
                        reason + ". File effects may have occurred; they were not retried."
                    )
                );
    }

    internal void RegisterFileStreamRoutes(WebApplication app) =>
        app.MapMethods("/node/transfer/{id}", ["GET", "PUT"], HandleFileStreamHttp);

    private async Task HandleFileStreamHttp(HttpContext context)
    {
        var credential = AuthenticateShell(context);
        if (credential is null)
            return;
        var id = context.Request.RouteValues["id"]?.ToString() ?? "";
        if (
            !fileStreams.TryGetValue(id, out var pending)
            || pending.Connection.Id != credential.Value.Id
            || (
                pending.Read
                    ? !HttpMethods.IsPut(context.Request.Method)
                    : !HttpMethods.IsGet(context.Request.Method)
            )
        )
        {
            context.Response.StatusCode = 404;
            return;
        }
        lock (gate)
            if (
                pending.Connection.Retired
                || !nodes.TryGetValue(credential.Value.Id, out var active)
                || !ReferenceEquals(active, pending.Connection)
            )
            {
                context.Response.StatusCode = 404;
                return;
            }
        if (
            pending.Read
            && (context.Request.ContentLength is not long length || length < StreamThreshold)
        )
        {
            context.Response.StatusCode = 400;
            return;
        }
        if (Interlocked.CompareExchange(ref pending.Claimed, 1, 0) != 0)
        {
            context.Response.StatusCode = 409;
            return;
        }
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = null;
        using var cancelled = context.RequestAborted.Register(() =>
            pending.Abort(new IOException("Node data connection closed."))
        );
        try
        {
            pending.Start.TrySetResult(context);
            if (pending.Read)
                await pending.Finished.Task.WaitAsync(pending.Stop.Token);
            else
            {
                context.Response.ContentLength = pending.Length;
                pending.Stop.CancelAfter(TimeSpan.FromSeconds(60));
                pending.Sha256 = await TransferStream.CopyAsync(
                    pending.Input!,
                    new ProgressWriteStream(context.Response.Body, pending.Stop),
                    pending.Length,
                    pending.Stop.Token
                );
                pending.Stop.CancelAfter(Timeout.InfiniteTimeSpan);
                pending.Finished.TrySetResult(true);
            }
        }
        catch (Exception error)
        {
            pending.Abort(error);
            context.Abort();
        }
    }

    private sealed class IncomingFileStream(
        NodeConnectionHub hub,
        string id,
        StreamInvocation invocation,
        HttpContext context,
        long length
    ) : Stream
    {
        private long count;
        private bool done;

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken,
                invocation.Stop.Token
            );
            try
            {
                var read = await context.Request.Body.ReadAsync(buffer, linked.Token);
                count += read;
                if (count > length || read == 0 && count != length)
                    throw new IOException("Source changed or transfer was interrupted.");
                if (read > 0)
                    invocation.Stop.CancelAfter(TimeSpan.FromSeconds(60));
                else
                {
                    done = true;
                    invocation.Stop.CancelAfter(Timeout.InfiniteTimeSpan);
                    invocation.Finished.TrySetResult(true);
                }
                return read;
            }
            catch (Exception error)
            {
                invocation.Abort(error);
                throw;
            }
        }

        public override async ValueTask DisposeAsync()
        {
            if (!done)
                invocation.Abort(new IOException("File transfer was interrupted."));
            hub.EndFileStream(id, invocation);
            await base.DisposeAsync();
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position
        {
            get => count;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }

    private sealed class ProgressWriteStream(Stream output, CancellationTokenSource stop) : Stream
    {
        public override async ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default
        )
        {
            await output.WriteAsync(buffer, cancellationToken);
            stop.CancelAfter(TimeSpan.FromSeconds(60));
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }
}
