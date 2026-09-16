using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.OpenAIResponses.Streaming;

var corpusPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "responses-stream-corpus.json");
var corpus = JsonSerializer.Deserialize<List<CorpusCase>>(await File.ReadAllTextAsync(corpusPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
var results = new JsonArray();
var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
foreach (var item in corpus)
{
    var progress = new List<ResponsesStreamProgress>(); var safety = new List<JsonObject>(); var blocks = new List<string>(); var decoded = new StringBuilder(); var meaningful = 0;
    var callbacks = new ResponsesStreamCallbacks { OnProgress = snapshot => progress.Add(snapshot), OnMeaningfulProgress = () => meaningful++, OnSafetyBuffering = metadata => safety.Add((JsonObject)metadata.DeepClone()), OnDecodedChunk = chunk => decoded.Append(chunk), OnSseBlock = block => blocks.Add(block) };
    JsonObject? final = null; JsonObject? error = null;
    try { final = await ResponsesSseCollector.CollectAsync(new ChunkedStream(item.Chunks.SelectMany(Encoding.UTF8.GetBytes).ToArray(), item.Chunks.Select(chunk => Encoding.UTF8.GetByteCount(chunk)).ToArray()), CancellationToken.None, callbacks, StreamOwnership.Dispose); }
    catch (OpenAiResponsesTerminalException terminal) { error = new JsonObject { ["category"] = "provider-terminal", ["kind"] = terminal.TerminalKind, ["message"] = terminal.Message, ["status"] = terminal.Status, ["code"] = terminal.Code }; }
    catch (MalformedSseEventJsonException malformed) { error = new JsonObject { ["category"] = "malformed-json", ["message"] = malformed.Message }; }
    catch (ResponsesStreamException streamError) { error = new JsonObject { ["category"] = streamError.Category switch { ResponsesStreamErrorCategory.EofBeforeCompleted => "eof-before-completed", ResponsesStreamErrorCategory.Read => "read", _ => "stream" }, ["message"] = streamError.Message }; }
    catch (OperationCanceledException) { error = new JsonObject { ["category"] = "cancellation" }; }
    var observation = new JsonObject { ["progress"] = JsonSerializer.SerializeToNode(progress, jsonOptions), ["meaningfulCount"] = meaningful, ["safety"] = new JsonArray(safety.Select(x => x.DeepClone()).ToArray()), ["decodedRaw"] = decoded.ToString(), ["blocks"] = new JsonArray(blocks.Select(x => JsonValue.Create(x)).ToArray()) };
    if (final is not null) { observation["status"] = "success"; observation["final"] = final; } else { observation["status"] = "error"; observation["error"] = error; }
    results.Add(new JsonObject { ["name"] = item.Name, ["observation"] = observation });
}
Console.Write(results.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));

sealed record CorpusCase(string Name, List<JsonObject> Events, List<string> Chunks);

sealed class ChunkedStream(byte[] data, int[] chunkSizes) : Stream
{
    private int position; private int chunkIndex; private bool disposed;
    public override bool CanRead => !disposed; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => data.Length; public override long Position { get => position; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    { cancellationToken.ThrowIfCancellationRequested(); if (position >= data.Length) return ValueTask.FromResult(0); var size = chunkIndex < chunkSizes.Length ? chunkSizes[chunkIndex++] : data.Length - position; size = Math.Min(size, data.Length - position); data.AsMemory(position, size).CopyTo(buffer); position += size; return ValueTask.FromResult(size); }
    protected override void Dispose(bool disposing) { disposed = true; base.Dispose(disposing); }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Flush() { } public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
