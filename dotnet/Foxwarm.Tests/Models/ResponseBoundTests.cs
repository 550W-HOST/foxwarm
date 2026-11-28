using System.Text;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ResponseBoundTests
{
    [Theory]
    [InlineData(4097, 0)]
    [InlineData(0, 4097)]
    public void SparsePositionsCannotPadArraysBeyondTheResponseBudget(int content, int annotation)
    {
        var accumulator = new ResponsesEventAccumulator();
        var value = new System.Text.Json.Nodes.JsonObject { ["type"] = "response.output_text.annotation.added",
            ["output_index"] = 0, ["content_index"] = content, ["annotation_index"] = annotation,
            ["annotation"] = new System.Text.Json.Nodes.JsonObject() };
        Assert.Throws<InvalidDataException>(() => accumulator.Consume(value));
    }

    [Fact]
    public async Task CompressedUnknownLengthContentIsLimitedAfterDecoding()
    {
        var compressed = new MemoryStream();
        using (var writer = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionLevel.Fastest, true))
            writer.Write(new byte[1024]);
        compressed.Position = 0;
        using var decoded = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionMode.Decompress);
        using var content = new StreamContent(decoded);
        Assert.Null(content.Headers.ContentLength);
        await Assert.ThrowsAsync<InvalidDataException>(() => Foxwarm.Net.BoundedResponse.ReadTextAsync(content, 64, "model", default));
    }

    [Theory]
    [InlineData("data: abcde", 8, 100)]
    [InlineData(": one\n\n: two\n\n", 8, 12)]
    [InlineData(":猫猫猫", 8, 100)]
    public async Task StreamRejectsOversizedEventOrAggregate(string source, int perEvent, int aggregate)
    {
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(source));
        await Assert.ThrowsAsync<InvalidDataException>(() => OpenAISseReader.ReadAsync(stream, default, _ => {}, null, StreamOwnership.LeaveOpen, eventBytes: perEvent, responseBytes: aggregate));
    }
}
