using System.Net;

namespace Foxwarm;

internal sealed partial class McpClient
{
    // The pinned SDK exposes no standalone-GET readiness event. Observe its real HTTP response
    // and body lifetime through the supported HttpClient seam, without parsing MCP/SSE frames.
    private sealed class ReceiveTransport
    {
        private readonly object gate = new();
        private long generation;
        private bool receiving;
        private string[] credentials = [];
        internal string[] Credentials
        {
            get
            {
                lock (gate)
                    return credentials;
            }
        }
        private TaskCompletionSource ready = NewReady();

        private static TaskCompletionSource NewReady() =>
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal bool Receiving
        {
            get
            {
                lock (gate)
                    return receiving;
            }
        }
        internal Task Ready
        {
            get
            {
                lock (gate)
                    return ready.Task;
            }
        }

        internal long Open(string[] selectedCredentials)
        {
            lock (gate)
            {
                credentials = selectedCredentials;
                if (ready.Task.IsFaulted)
                    ready = NewReady();
                receiving = true;
                ready.TrySetResult();
                return ++generation;
            }
        }

        internal void Fail()
        {
            lock (gate)
            {
                receiving = false;
                credentials = [];
                ready.TrySetException(
                    new InvalidOperationException("MCP notification stream is unavailable.")
                );
                _ = ready.Task.Exception;
            }
        }

        internal void End(long captured)
        {
            lock (gate)
            {
                if (captured != generation)
                    return;
                receiving = false;
                credentials = [];
                if (ready.Task.IsCompleted)
                    ready = NewReady();
            }
        }

        internal sealed class Handler(
            ReceiveTransport observer,
            Action lost,
            HttpMessageHandler inner,
            bool oauth,
            Func<string[]> currentCredentials
        ) : DelegatingHandler(inner)
        {
            protected override async Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken token
            )
            {
                using var delete =
                    request.Method == HttpMethod.Delete
                        ? CancellationTokenSource.CreateLinkedTokenSource(token)
                        : null;
                delete?.CancelAfter(TimeSpan.FromSeconds(5));
                var get =
                    request.Method == HttpMethod.Get && request.Headers.Contains("Mcp-Session-Id");
                HttpResponseMessage response;
                try
                {
                    response = await base.SendAsync(request, delete?.Token ?? token);
                }
                catch
                {
                    if (get)
                        observer.Fail();
                    throw;
                }
                if (
                    request.Method != HttpMethod.Delete
                    && request.Headers.Contains("Mcp-Session-Id")
                    && (
                        response.StatusCode == HttpStatusCode.NotFound
                        || !oauth
                            && response.StatusCode
                                is HttpStatusCode.Unauthorized
                                    or HttpStatusCode.Forbidden
                    )
                )
                    lost();
                if (!get)
                    return response;
                if (
                    !response.IsSuccessStatusCode
                    || response.Content.Headers.ContentType?.MediaType != "text/event-stream"
                )
                {
                    observer.Fail();
                    return response;
                }
                var content = response.Content;
                var body = await content.ReadAsStreamAsync(token);
                var selected = currentCredentials()
                    .Concat(
                        new[]
                        {
                            request.Headers.Authorization?.Parameter,
                            response.RequestMessage?.Headers.Authorization?.Parameter,
                        }
                            .Where(value => !string.IsNullOrEmpty(value))
                            .Select(value => value!)
                    )
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                var captured = observer.Open(selected);
                var replacement = new StreamContent(
                    new ObservedStream(body, () => observer.End(captured), content)
                );
                foreach (var header in content.Headers)
                    replacement.Headers.TryAddWithoutValidation(header.Key, header.Value);
                response.Content = replacement;
                return response;
            }
        }

        private sealed class ObservedStream(Stream body, Action ended, HttpContent content) : Stream
        {
            private int closed;

            private void End()
            {
                if (Interlocked.Exchange(ref closed, 1) == 0)
                    ended();
            }

            public override async ValueTask<int> ReadAsync(
                Memory<byte> buffer,
                CancellationToken cancellationToken = default
            )
            {
                try
                {
                    var count = await body.ReadAsync(buffer, cancellationToken);
                    if (count == 0)
                        End();
                    return count;
                }
                catch
                {
                    End();
                    throw;
                }
            }

            public override Task<int> ReadAsync(
                byte[] buffer,
                int offset,
                int count,
                CancellationToken cancellationToken
            ) => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

            public override int Read(byte[] buffer, int offset, int count)
            {
                try
                {
                    var read = body.Read(buffer, offset, count);
                    if (read == 0)
                        End();
                    return read;
                }
                catch
                {
                    End();
                    throw;
                }
            }

            protected override void Dispose(bool disposing)
            {
                End();
                if (disposing)
                    content.Dispose();
                base.Dispose(disposing);
            }

            public override async ValueTask DisposeAsync()
            {
                End();
                await body.DisposeAsync();
                content.Dispose();
                GC.SuppressFinalize(this);
            }

            public override bool CanRead => body.CanRead;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override void Flush() => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) =>
                throw new NotSupportedException();

            public override long Seek(long offset, SeekOrigin origin) =>
                throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();
        }
    }
}
