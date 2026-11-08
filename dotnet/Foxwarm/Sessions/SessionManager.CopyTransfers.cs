using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private sealed class CopyTransfer(
        SessionOwner owner,
        string source,
        string sourcePath,
        string target,
        string targetPath,
        bool overwrite,
        CancellationToken shutdown
    )
    {
        internal readonly string Id = "transfer_" + Guid.NewGuid().ToString("N");
        internal readonly SessionOwner Owner = owner;
        internal readonly string Source = source;
        internal readonly string SourcePath = sourcePath;
        internal readonly string Target = target;
        internal readonly string TargetPath = targetPath;
        internal readonly bool Overwrite = overwrite;
        internal readonly CancellationTokenSource Stop =
            CancellationTokenSource.CreateLinkedTokenSource(
                owner.Entry.IdentityLossToken,
                shutdown
            );
        internal readonly TaskCompletionSource<bool> Background = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly Stopwatch Clock = Stopwatch.StartNew();
        internal long Size = -1;
        internal long Copied;
        internal Task<JsonObject> Work = null!;
        internal Task Observer = null!;
        internal bool HandedOff;
    }

    private readonly object copyGate = new();
    private readonly Dictionary<string, CopyTransfer> copies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CopyTransfer> recentCopies = new(StringComparer.Ordinal);

    internal async Task<JsonObject> CopyBetweenNodesAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(
            args,
            ["sourceNode", "sourcePath", "targetNode", "targetPath", "overwrite", "timeout"]
        );
        string Required(string key) =>
            ToolRegistry.Text(args, key) is { } value && !string.IsNullOrWhiteSpace(value)
                ? value
                : throw new InvalidDataException("copy_between_nodes requires " + key + ".");
        var source = Required("sourceNode").Trim();
        var target = Required("targetNode").Trim();
        var sourcePath = Required("sourcePath");
        var targetPath = Required("targetPath");
        var overwrite = OptionalBool(args, "overwrite") ?? false;
        var (seconds, warning) = ExecOutput.Timeout(args["timeout"]);
        token.ThrowIfCancellationRequested();
        var transfer = new CopyTransfer(
            owner,
            source,
            sourcePath,
            target,
            targetPath,
            overwrite,
            admissionStop.Token
        );
        var copiedArgs = (JsonObject)args.DeepClone();
        lock (copyGate)
        {
            copies.Add(transfer.Id, transfer);
            using (ExecutionContext.SuppressFlow())
                transfer.Work = Task.Run(() => CopyTransferCoreAsync(transfer, copiedArgs));
            transfer.Observer = ObserveCopyTransferAsync(transfer);
        }
        using var delayStop = new CancellationTokenSource();
        var delay = Task.Delay(TimeSpan.FromSeconds(seconds), delayStop.Token);
        var interrupted = Task.Delay(Timeout.InfiniteTimeSpan, token);
        await Task.WhenAny(transfer.Work, delay, interrupted);
        bool background;
        lock (copyGate)
        {
            background = !transfer.Work.IsCompleted;
            transfer.HandedOff = background;
            transfer.Background.TrySetResult(background);
        }
        delayStop.Cancel();
        if (!background)
        {
            var result = await transfer.Work;
            if (warning is not null)
                result["output"] = warning + "\n" + SessionWait.Text(result["output"]);
            return result;
        }
        var copied = Interlocked.Read(ref transfer.Copied);
        var size = Interlocked.Read(ref transfer.Size);
        return new JsonObject
        {
            ["output"] =
                (warning is null ? "" : warning + "\n")
                + $"Copy continues in the background ({transfer.Id}).",
            ["transferId"] = transfer.Id,
            ["bytesCopied"] = copied,
            ["sizeBytes"] = size < 0 ? null : JsonValue.Create(size),
            ["elapsed"] = transfer.Clock.Elapsed.TotalSeconds,
        };
    }

    private async Task<JsonObject> CopyTransferCoreAsync(CopyTransfer transfer, JsonObject args)
    {
        var owner = transfer.Owner;
        var token = transfer.Stop.Token;
        TransferSource? source = null;
        TransferStartStream? start = null;
        Task<(string Path, string Sha256)>? writing = null;
        try
        {
            using (BeginOwnerMutation(owner))
            {
                var files = AgentFileWorkspace(owner);
                await AuthorizeToolAsync(
                    owner,
                    new("copy_between_nodes", "builtin", "copy_between_nodes", args),
                    files,
                    token
                );
                source = await OpenNodeReadAsync(
                    owner,
                    transfer.Source,
                    transfer.SourcePath,
                    files,
                    token
                );
                Interlocked.Exchange(ref transfer.Size, source.Length);
                start = new TransferStartStream(source.Stream);
                writing = WriteNodeStreamAsync(
                    owner,
                    transfer.Target,
                    transfer.TargetPath,
                    start,
                    source.Length,
                    transfer.Overwrite,
                    files,
                    token,
                    value => Interlocked.Exchange(ref transfer.Copied, value)
                );
                var first = await Task.WhenAny(start.Ready.Task, writing);
                if (ReferenceEquals(first, writing))
                    await writing;
            }
            start.Release();
            var result = await writing!;
            return new JsonObject
            {
                ["output"] =
                    $"Copied `{transfer.SourcePath}` on `{transfer.Source}` to `{transfer.TargetPath}` on `{transfer.Target}` ({source.Length} bytes).",
                ["targetNode"] = transfer.Target,
                ["fullPath"] = result.Path,
                ["sizeBytes"] = source.Length,
                ["sha256"] = result.Sha256,
            };
        }
        finally
        {
            start?.Release();
            if (source is not null)
                await source.DisposeAsync();
        }
    }

    private async Task ObserveCopyTransferAsync(CopyTransfer transfer)
    {
        JsonObject? result = null;
        Exception? failure = null;
        try
        {
            result = await transfer.Work;
        }
        catch (Exception error)
        {
            failure = error;
        }
        var background = await transfer.Background.Task;
        if (background && Accepting && !IsDeletionClaimed(transfer.Owner.Id))
        {
            var details = new JsonObject
            {
                ["transferId"] = transfer.Id,
                ["sourceNode"] = transfer.Source,
                ["sourcePath"] = transfer.SourcePath,
                ["targetNode"] = transfer.Target,
                ["targetPath"] = transfer.TargetPath,
                ["sizeBytes"] =
                    Interlocked.Read(ref transfer.Size) < 0
                        ? null
                        : JsonValue.Create(Interlocked.Read(ref transfer.Size)),
                ["bytesCopied"] = Interlocked.Read(ref transfer.Copied),
                ["status"] =
                    failure is null ? "completed"
                    : transfer.Stop.IsCancellationRequested ? "cancelled"
                    : "failed",
                ["sha256"] = result?["sha256"]?.DeepClone(),
                ["error"] = failure?.Message,
            };
            if (failure is not null)
                details["targetEffect"] = NodeProviders.IsProviderNode(transfer.Target)
                    ? "The destination may retain a partial file."
                    : "An incomplete body is not published; a completed body may already have been published.";
            var message =
                "<foxwarm-system kind=\"event\" type=\"background-transfer-finished\">\n"
                + details.ToJsonString()
                + "\n</foxwarm-system>";
            try
            {
                while (Accepting && !IsDeletionClaimed(transfer.Owner.Id))
                {
                    await WaitForIdentityMutationAsync(transfer.Owner.Id);
                    try
                    {
                        using var admission = BeginOwnerMutation(transfer.Owner);
                        var admitted =
                            await transfer.Owner.Entry.SaveLane.CommitBackgroundExecCompletionAsync(
                                transfer.Id,
                                message
                            );
                        if (admitted)
                            WakeNodeEventOwner(transfer.Owner);
                        break;
                    }
                    catch (InvalidOperationException) when (IdentityMovePending(transfer.Owner.Id))
                    { }
                }
            }
            catch (Exception error)
            {
                transfer.Owner.Entry.RecordBackgroundProcessorFailure(error);
            }
        }
        lock (copyGate)
        {
            copies.Remove(transfer.Id);
            if (background && Accepting && !transfer.Owner.Entry.Retired)
            {
                recentCopies[transfer.Id] = transfer;
            }
        }
        transfer.Stop.Dispose();
    }

    private bool IdentityMovePending(string id)
    {
        lock (lifecycle)
            return identityMoveClaims.ContainsKey(id);
    }

    internal async Task<JsonObject> CancelCopyTransferAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["transferId"]);
        var id = ToolRegistry.Text(args, "transferId");
        if (string.IsNullOrWhiteSpace(id))
            throw new InvalidDataException("cancel_transfer requires transferId.");
        token.ThrowIfCancellationRequested();
        CopyTransfer? transfer;
        lock (copyGate)
        {
            transfer = copies.GetValueOrDefault(id) ?? recentCopies.GetValueOrDefault(id);
            if (transfer is null || !ReferenceEquals(transfer.Owner, owner) || !transfer.HandedOff)
                throw new InvalidDataException(
                    "No background copy with that transfer ID belongs to this Session."
                );
        }
        if (transfer.Work.IsCompleted)
            return await CompletedCopyReceiptAsync(transfer);
        try
        {
            transfer.Stop.Cancel();
        }
        catch (ObjectDisposedException) { }
        if (transfer.Work.IsCompleted)
            return await CompletedCopyReceiptAsync(transfer);
        return new JsonObject
        {
            ["output"] = $"Cancellation requested for copy {id}.",
            ["transferId"] = id,
            ["status"] = "cancelling",
        };
    }

    private static async Task<JsonObject> CompletedCopyReceiptAsync(CopyTransfer transfer)
    {
        try
        {
            return (JsonObject)(await transfer.Work).DeepClone();
        }
        catch (Exception error)
        {
            return new JsonObject
            {
                ["transferId"] = transfer.Id,
                ["status"] = transfer.Stop.IsCancellationRequested ? "cancelled" : "failed",
                ["output"] =
                    "Copy "
                    + (transfer.Stop.IsCancellationRequested ? "was cancelled: " : "failed: ")
                    + error.Message,
            };
        }
    }

    private async Task RetireCopyTransfersAsync(SessionOwner owner)
    {
        CopyTransfer[] active;
        lock (copyGate)
            active = copies.Values.Where(item => ReferenceEquals(item.Owner, owner)).ToArray();
        foreach (var transfer in active)
        {
            try
            {
                transfer.Stop.Cancel();
            }
            catch (ObjectDisposedException) { }
        }
        await Task.WhenAll(active.Select(item => item.Observer));
        lock (copyGate)
            foreach (
                var id in recentCopies
                    .Where(pair => ReferenceEquals(pair.Value.Owner, owner))
                    .Select(pair => pair.Key)
                    .ToArray()
            )
                recentCopies.Remove(id);
    }

    private async Task DrainCopyTransfersAsync()
    {
        CopyTransfer[] active;
        lock (copyGate)
            active = copies.Values.ToArray();
        await Task.WhenAll(active.Select(item => item.Observer));
    }

    private bool HasCopyTransfer(SessionOwner owner, string id)
    {
        lock (copyGate)
            return copies.TryGetValue(id, out var transfer)
                && transfer.HandedOff
                && ReferenceEquals(owner, transfer.Owner);
    }

    private sealed class TransferStartStream(Stream inner) : Stream
    {
        internal readonly TaskCompletionSource Ready = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        private readonly TaskCompletionSource release = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        internal void Release() => release.TrySetResult();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken token = default
        )
        {
            Ready.TrySetResult();
            await release.Task.WaitAsync(token);
            return await inner.ReadAsync(buffer, token);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
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
