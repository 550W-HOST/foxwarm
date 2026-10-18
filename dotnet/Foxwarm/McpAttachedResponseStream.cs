namespace Foxwarm;

// Pinned SDK 2.2.0 writes one complete SSE event per WriteAsync; upgrades must requalify this seam.
// No parsing, event buffer, event IDs, replay, or replacement protocol implementation.
internal sealed class McpAttachedResponseStream : Stream
{
    private readonly object gate = new();
    private Attachment? current;
    private bool stopped;
    private readonly AsyncLocal<Attachment?> sendAttachment = new();
    private int inFlight;
    private TaskCompletionSource allDrained = CompletedSignal();
    public TaskCompletionSource Ready { get; } = NewSignal();

    public Attachment? Attach(Stream body)
    {
        lock (gate)
        {
            if (stopped || current is not null) return null;
            return current = new Attachment(body);
        }
    }

    public bool Activate(Attachment attachment)
    {
        lock (gate)
        {
            if (stopped || !ReferenceEquals(current, attachment)) return false;
            attachment.Active = true;
            return true;
        }
    }

    // Identity check prevents old HTTP cleanup from detaching a successor.
    public void Detach(Attachment attachment)
    {
        lock (gate)
        {
            if (attachment.Detached) return;
            attachment.Detached = true;
            if (ReferenceEquals(current, attachment)) current = null;
            attachment.Body = null; // No retired response body remains in context/attachment state.
            if (attachment.InFlight == 0) attachment.Drained.TrySetResult();
        }
        attachment.Cancel.Cancel();
        attachment.Ended.TrySetResult();
    }

    // All application-originated unsolicited sends enter here. Capturing before the SDK's
    // own send lock prevents a waiting old/offline send from acquiring a successor's authority.
    public async Task<bool> SendAsync(Func<Task> send)
    {
        Attachment? attachment;
        lock (gate) attachment = stopped || current is not { Active: true } ? null : current;
        if (attachment is null) return false;
        var previous = sendAttachment.Value;
        sendAttachment.Value = attachment;
        try { await send(); }
        finally { sendAttachment.Value = previous; }
        return true; // Accepted attempt, never a receiver acknowledgment.
    }

    public async Task StopAsync()
    {
        Attachment? attachment;
        Task drain;
        lock (gate)
        {
            stopped = true;
            attachment = current;
            drain = allDrained.Task;
        }
        if (attachment is not null)
        {
            Detach(attachment);
            await attachment.Ended.Task;
        }
        await drain;
    }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        Attachment? attachment;
        Stream? body;
        lock (gate)
        {
            attachment = sendAttachment.Value;
            body = attachment?.Body;
            if (attachment is null || !attachment.Active || stopped || !ReferenceEquals(attachment, current))
            {
                return;
            }
            attachment.InFlight++;
            if (inFlight++ == 0) allDrained = NewSignal();
        }
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, attachment.Cancel.Token);
            // One frame goes to one attachment only, including flush. Never retry a failed write.
            await body!.WriteAsync(buffer, linked.Token);
            await body.FlushAsync(linked.Token);
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException or InvalidOperationException)
        {
            // Do not let an HTTP failure permanently fault the sole SDK GET task or poison its
            // reusable SSE writer buffers (which SDK 2.2.0 resets only after successful return).
            Detach(attachment);
        }
        finally
        {
            lock (gate)
            {
                attachment.InFlight--;
                if (attachment.Detached && attachment.InFlight == 0)
                {
                    attachment.Drained.TrySetResult();
                }
                if (--inFlight == 0) allDrained.TrySetResult();
            }
        }
    }

    public override Task FlushAsync(CancellationToken cancellationToken)
    {
        // SDK's first empty flush means its writer is installed. Per-frame flush is above,
        // so a following SDK FlushAsync cannot accidentally flush a successor attachment.
        Ready.TrySetResult();
        return Task.CompletedTask;
    }

    public sealed class Attachment(Stream body)
    {
        internal Stream? Body = body;
        internal int InFlight;
        internal bool Detached;
        internal bool Active;
        public CancellationTokenSource Cancel { get; } = new();
        public TaskCompletionSource Ended { get; } = NewSignal();
        public TaskCompletionSource Drained { get; } = NewSignal();
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static TaskCompletionSource CompletedSignal()
    {
        var signal = NewSignal();
        signal.SetResult();
        return signal;
    }
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() => FlushAsync(default).GetAwaiter().GetResult();
    public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}
