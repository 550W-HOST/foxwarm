using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ResponsesStreamingTests
{
    [Fact]
    public void Accumulator_reconstructs_reasoning_text_function_call_and_keeps_unknown_fields()
    {
        var progress = new List<ResponsesStreamProgress>(); var meaningful = 0;
        var accumulator = new ResponsesEventAccumulator(new ResponsesStreamCallbacks { OnProgress = snapshot => progress.Add(snapshot), OnMeaningfulProgress = () => meaningful++ });
        accumulator.Consume(Event("response.output_item.added", ("output_index", 0), ("item", Obj(("type", "reasoning"), ("summary", new JsonArray()), ("vendor", Obj(("x", true)))))));
        accumulator.Consume(Event("response.reasoning_summary_text.delta", ("output_index", 0), ("summary_index", 0), ("delta", "Think")));
        accumulator.Consume(Event("response.reasoning_summary_text.done", ("output_index", 0), ("summary_index", 0), ("text", "Thinking done")));
        accumulator.Consume(Event("response.output_item.added", ("output_index", 1), ("item", Obj(("type", "message"), ("role", "assistant"), ("content", new JsonArray())))));
        accumulator.Consume(Event("response.output_text.delta", ("output_index", 1), ("content_index", 0), ("delta", "Hi")));
        accumulator.Consume(Event("response.output_item.added", ("output_index", 2), ("item", Obj(("type", "function_call"), ("call_id", "c1"), ("name", "read"), ("arguments", "")))));
        accumulator.Consume(Event("response.function_call_arguments.delta", ("output_index", 2), ("delta", "{}")));
        accumulator.Consume(Event("response.completed", ("response", Obj(("id", "r1"), ("output", new JsonArray())))));
        var result = accumulator.CompleteAtEof();
        Assert.Equal(3, ((JsonArray)result["output"]!).Count);
        Assert.Equal("Thinking done", result["output"]![0]!["summary"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("Hi", result["output"]![1]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("{}", result["output"]![2]!["arguments"]!.GetValue<string>());
        Assert.True(result["output"]![0]!["vendor"]!["x"]!.GetValue<bool>());
        Assert.True(meaningful >= 4); Assert.NotEmpty(progress);
    }

    [Fact]
    public void Accumulator_preserves_sparse_index_order_and_rejects_unaligned_completed_output()
    {
        var accumulator = new ResponsesEventAccumulator();
        accumulator.Consume(Event("response.output_item.added", ("output_index", 2), ("item", Obj(("type", "web_search_call"), ("id", "search")))));
        accumulator.Consume(Event("response.output_item.added", ("output_index", 4), ("item", Obj(("type", "message"), ("role", "assistant"), ("content", new JsonArray())))));
        accumulator.Consume(Event("response.output_text.delta", ("output_index", 4), ("content_index", 0), ("delta", "answer")));
        accumulator.Consume(Event("response.completed", ("response", Obj(("output", new JsonArray(Obj(("type", "message"), ("role", "assistant"), ("content", new JsonArray()))))))));
        var result = accumulator.CompleteAtEof();
        Assert.Equal("web_search_call", result["output"]![0]!["type"]!.GetValue<string>());
        Assert.Equal("message", result["output"]![1]!["type"]!.GetValue<string>());
        Assert.Equal("answer", result["output"]![1]!["content"]![0]!["text"]!.GetValue<string>());
    }

    [Fact]
    public void Accumulator_aligned_enrichment_preserves_streamed_summary_annotations_arguments_and_phase()
    {
        var accumulator = new ResponsesEventAccumulator();
        accumulator.Consume(Event("response.output_item.added", ("output_index", 0), ("item", Obj(("type", "reasoning"), ("summary", new JsonArray())))));
        accumulator.Consume(Event("response.reasoning_summary_text.delta", ("output_index", 0), ("summary_index", 0), ("delta", "one")));
        accumulator.Consume(Event("response.output_item.added", ("output_index", 1), ("item", Obj(("type", "function_call"), ("call_id", "c"), ("arguments", "{\"x\":1}")))));
        accumulator.Consume(Event("response.output_item.added", ("output_index", 2), ("item", Obj(("type", "message"), ("role", "assistant"), ("phase", "commentary"), ("content", new JsonArray())))));
        accumulator.Consume(Event("response.output_text.delta", ("output_index", 2), ("content_index", 0), ("delta", "text")));
        var completed = new JsonArray(
            Obj(("type", "reasoning"), ("status", "completed"), ("summary", new JsonArray(Obj(("type", "summary_text"), ("text", "condensed"))))),
            Obj(("type", "function_call"), ("call_id", "c"), ("arguments", "")),
            Obj(("type", "message"), ("role", "assistant"), ("content", new JsonArray(Obj(("type", "output_text"), ("text", "text"))))));
        accumulator.Consume(Event("response.completed", ("response", Obj(("output", completed)))));
        var result = accumulator.CompleteAtEof();
        Assert.Equal("one", result["output"]![0]!["summary"]![0]!["text"]!.GetValue<string>());
        Assert.Equal("{\"x\":1}", result["output"]![1]!["arguments"]!.GetValue<string>());
        Assert.Equal("commentary", result["output"]![2]!["phase"]!.GetValue<string>());
    }

    [Fact]
    public void Accumulator_reasoning_done_empty_retains_existing_summary_without_progress()
    {
        var progress = new List<ResponsesStreamProgress>(); var accumulator = new ResponsesEventAccumulator(new ResponsesStreamCallbacks { OnProgress = snapshot => progress.Add(snapshot) });
        accumulator.Consume(Event("response.reasoning_summary_text.delta", ("output_index", 0), ("summary_index", 0), ("delta", "kept")));
        var count = progress.Count;
        accumulator.Consume(Event("response.reasoning_summary_text.done", ("output_index", 0), ("summary_index", 0), ("text", "")));
        Assert.Equal(count, progress.Count);
        accumulator.Consume(Event("response.completed", ("response", Obj(("output", new JsonArray(Obj(("type", "reasoning"))))))));
        Assert.Equal("kept", progress[^1].Reasoning);
    }

    [Fact]
    public void Accumulator_is_owned_and_terminal_errors_are_typed()
    {
        var source = Event("response.output_item.added", ("output_index", 0), ("item", Obj(("type", "message"), ("content", new JsonArray()))));
        var accumulator = new ResponsesEventAccumulator(); accumulator.Consume(source); source["item"]!["type"] = "changed";
        accumulator.Consume(Event("response.completed", ("response", Obj(("output", new JsonArray())))));
        Assert.Equal("message", accumulator.CompleteAtEof()["output"]![0]!["type"]!.GetValue<string>());
        var error = Assert.Throws<OpenAiResponsesTerminalException>(() => new ResponsesEventAccumulator().Consume(Event("response.failed", ("response", Obj(("error", Obj(("message", "bad"), ("status", 500), ("code", "x"))))))));
        Assert.Equal("response.failed", error.TerminalKind); Assert.Equal("bad", error.Message); Assert.Equal("500", error.Status); Assert.Equal("x", error.Code);
    }

    [Fact]
    public void Accumulator_terminal_label_does_not_override_event_fallback()
    {
        var error = Assert.Throws<OpenAiResponsesTerminalException>(() => new ResponsesEventAccumulator().Consume(Event("response.failed", ("response", Obj(("label", "provider label"))))));
        Assert.Equal("OpenAI Responses request failed.", error.Message);
    }

    [Theory]
    [InlineData("response.failed", "response.failed")]
    [InlineData("response.incomplete", "response.incomplete")]
    [InlineData("response.error", "response.error")]
    [InlineData("error", "error")]
    public void Accumulator_recognizes_all_provider_terminal_event_shapes(string type, string expectedKind)
    {
        var eventNode = type is "response.failed" or "response.incomplete"
            ? Event(type, ("response", Obj(("error", Obj(("message", "terminal"), ("status", "bad"), ("code", "x"))))))
            : type == "response.error"
                ? Event(type, ("error", Obj(("message", "terminal"), ("status", "bad"), ("code", "x"))))
                : Event(type, ("message", "terminal"), ("status", "bad"), ("code", "x"));
        var error = Assert.Throws<OpenAiResponsesTerminalException>(() => new ResponsesEventAccumulator().Consume(eventNode));
        Assert.Equal(expectedKind, error.TerminalKind); Assert.Equal("terminal", error.Message); Assert.Equal("bad", error.Status); Assert.Equal("x", error.Code);
    }

    [Fact]
    public async Task Collector_handles_fragmented_utf8_crlf_comments_data_lines_and_callbacks()
    {
        var body = "comment\r\nevent: ignored\r\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"hé😀\"}\r\n\r\ndata: {\r\ndata: \"type\":\"response.completed\",\r\ndata: \"response\":{\"output\":[]}}\r\n\r\ndata: [DONE]\r\n\r\n";
        var stream = new ChunkedStream(Encoding.UTF8.GetBytes(body), new[] { 1, 2, 3, 7, 11, 19, 23, 31 });
        var raw = new StringBuilder(); var blocks = new List<string>();
        var result = await ResponsesSseCollector.CollectAsync(stream, CancellationToken.None, new ResponsesStreamCallbacks { OnDecodedChunk = chunk => raw.Append(chunk), OnSseBlock = block => blocks.Add(block) });
        Assert.Equal("hé😀", result["output"]![0]!["content"]![0]!["text"]!.GetValue<string>());
        Assert.Equal(body, raw.ToString()); Assert.Equal(4, blocks.Count); Assert.True(stream.Disposed);
    }

    [Fact]
    public async Task Collector_ignores_unterminated_final_block_and_reports_read_errors()
    {
        await Assert.ThrowsAsync<ResponsesStreamException>(() => ResponsesSseCollector.CollectAsync(new MemoryStream(Encoding.UTF8.GetBytes("data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}")), CancellationToken.None));
        var error = await Assert.ThrowsAsync<ResponsesStreamReadException>(() => ResponsesSseCollector.CollectAsync(new ErrorStream(), CancellationToken.None));
        Assert.Equal(ResponsesStreamErrorCategory.Read, error.Category);
    }

    [Fact]
    public async Task Collector_replaces_invalid_utf8_and_reports_eof_malformed_cancel_and_leave_open()
    {
        var invalid = new MemoryStream(new byte[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a', (byte)':', (byte)' ', 0xC3, 0x28, (byte)'\n', (byte)'\n' });
        var raw = new StringBuilder(); await Assert.ThrowsAnyAsync<ResponsesStreamException>(() => ResponsesSseCollector.CollectAsync(invalid, CancellationToken.None, new ResponsesStreamCallbacks { OnDecodedChunk = chunk => raw.Append(chunk) })); Assert.Contains("�", raw.ToString());
        var malformed = await Assert.ThrowsAsync<MalformedSseEventJsonException>(() => ResponsesSseCollector.CollectAsync(new MemoryStream(Encoding.UTF8.GetBytes("data: {bad}\n\n")), CancellationToken.None)); Assert.Equal("data: {bad}", malformed.Block);
        var stream = new MemoryStream(Encoding.UTF8.GetBytes("data: [DONE]\n\n")); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ResponsesSseCollector.CollectAsync(stream, new CancellationToken(true))); Assert.True(stream.CanRead);
        var leave = new MemoryStream(Encoding.UTF8.GetBytes("data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n")); await ResponsesSseCollector.CollectAsync(leave, CancellationToken.None, ownership: StreamOwnership.LeaveOpen); Assert.True(leave.CanRead);
    }

    [Fact]
    public async Task Collector_disposes_held_http_body_on_cancellation_and_server_observes_close()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var accepted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var requested = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync(); accepted.SetResult(); await using var network = client.GetStream(); var request = new StringBuilder(); var buffer = new byte[256];
            while (!request.ToString().Contains("\r\n\r\n", StringComparison.Ordinal)) { var read = await network.ReadAsync(buffer); if (read == 0) return; request.Append(Encoding.ASCII.GetString(buffer, 0, read)); }
            requested.SetResult(); await network.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n")); held.SetResult();
            while (true) { var read = await network.ReadAsync(buffer); if (read == 0) { closed.SetResult(); return; } }
        });
        using var http = new HttpClient(); using var cancellation = new CancellationTokenSource();
        using var response = await http.GetAsync(new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/stream"), HttpCompletionOption.ResponseHeadersRead); var body = await response.Content.ReadAsStreamAsync(); var collection = ResponsesSseCollector.CollectAsync(body, cancellation.Token, ownership: StreamOwnership.Dispose);
        await Task.WhenAll(accepted.Task, requested.Task, held.Task).WaitAsync(TimeSpan.FromSeconds(5)); cancellation.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => collection.WaitAsync(TimeSpan.FromSeconds(5))); await closed.Task.WaitAsync(TimeSpan.FromSeconds(5)); listener.Stop(); await server.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static JsonObject Event(string type, params (string Name, object? Value)[] fields) { var obj = new JsonObject { ["type"] = type }; foreach (var (name, value) in fields) obj[name] = ToNode(value); return obj; }
    private static JsonObject Obj(params (string Name, object? Value)[] fields) { var obj = new JsonObject(); foreach (var (name, value) in fields) obj[name] = ToNode(value); return obj; }
    private static JsonNode? ToNode(object? value) => value switch { null => null, JsonNode node => node.DeepClone(), _ => JsonValue.Create(value) };

    private sealed class ErrorStream : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => 0; public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new IOException("read failed"); public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => ValueTask.FromException<int>(new IOException("read failed"));
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Flush() { } public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class ChunkedStream(byte[] data, int[] cuts) : Stream
    {
        private int position; private int cutIndex; public bool Disposed { get; private set; }
        public override bool CanRead => !Disposed; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => data.Length; public override long Position { get => position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { cancellationToken.ThrowIfCancellationRequested(); if (position >= data.Length) return ValueTask.FromResult(0); var size = cutIndex < cuts.Length ? cuts[cutIndex++] : data.Length - position; size = Math.Min(size, data.Length - position); data.AsMemory(position, size).CopyTo(buffer); position += size; return ValueTask.FromResult(size); }
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Flush() { } public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
