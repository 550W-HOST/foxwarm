using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ArchiveOpaqueFieldsTests
{
    private static JsonObject Message(JsonNode? meta, int seq = 1) =>
        new()
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "Synthetic archived answer" }),
            ["providerMeta"] = meta,
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = 1000 + seq },
        };

    private static JsonObject Legacy(JsonObject message, int seq = 1) =>
        new()
        {
            ["v"] = 1,
            ["kind"] = "message",
            ["sessionId"] = "opaque",
            ["agent"] = "main",
            ["seq"] = seq,
            ["timestamp"] = 1000 + seq,
            ["role"] = "model",
            ["message"] = message,
        };

    [Fact]
    public async Task Legacy_import_and_existing_sqlite_reads_preserve_independent_opaque_objects()
    {
        using var temp = new TempDirectory();
        var logs = Path.Combine(temp.Path, "state/logs/sessions");
        Directory.CreateDirectory(logs);
        var metadata = new[]
        {
            "{\"providerSpecificFields\":{\"signature\":\"old\"},\"sourceModelId\":\"a/wire\"}",
            "{\"extraFields\":{\"nested\":{\"nullValue\":null},\"list\":[null,2]},\"sourceModelId\":\"a/wire\"}",
            "{\"extraFields\":{},\"providerSpecificFields\":{\"signature\":\"both\"},\"sourceModelId\":\"a/wire\"}",
            "{}",
        };
        var messages = metadata
            .Select((text, index) => Message(JsonNode.Parse(text), index + 1))
            .ToArray();
        var file = Path.Combine(logs, "opaque.jsonl");
        await File.WriteAllLinesAsync(
            file,
            messages.Select(
                (message, index) =>
                    Legacy((JsonObject)message.DeepClone(), index + 1).ToJsonString()
            )
        );
        await SqliteArchiveMessageStore.ImportLegacyAsync(temp.Path);
        var database = Path.Combine(temp.Path, "state/archive-store.sqlite");
        var store = new SqliteArchiveMessageStore(database, "opaque");
        var imported = store.ReadMessages();
        Assert.Equal(messages.Length, imported.Count);
        for (var index = 0; index < messages.Length; index++)
            Assert.True(JsonNode.DeepEquals(messages[index], imported[index].Message));
        // The native writer accepts the same shape without rewriting the imported records.
        var next = Message(JsonNode.Parse(metadata[1]), 5);
        Assert.Single(
            store.WriteMessages([ArchiveMessageRecord.Create("opaque", "main", 5, 1005, next)])
        );
        var reopened = new SqliteArchiveMessageStore(database, "opaque").ReadMessages();
        Assert.Equal(5, reopened.Count);
        Assert.Equal(
            imported.Select(row => row.MessageJson),
            reopened.Take(4).Select(row => row.MessageJson)
        );
        Assert.True(JsonNode.DeepEquals(next, reopened[4].Message));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{\"extraFields\":[]}")]
    [InlineData("{\"extraFields\":null}")]
    [InlineData("{\"extraFields\":1}")]
    [InlineData("{\"providerSpecificFields\":[]}")]
    [InlineData("{\"providerSpecificFields\":null}")]
    [InlineData("{\"extraFields\":{},\"sourceModelId\":3}")]
    public async Task Malformed_metadata_is_rejected_by_native_writer_reader_and_legacy_import(
        string metadata
    )
    {
        var message = Message(JsonNode.Parse(metadata));
        Assert.Throws<InvalidDataException>(() =>
            ArchiveMessageRecord.Create("opaque", "main", 1, 1001, message)
        );
        Assert.Throws<InvalidDataException>(() =>
            ArchiveMessageRecord.FromStored(
                "opaque",
                "main",
                1,
                1001,
                "model",
                message.ToJsonString()
            )
        );
        using var temp = new TempDirectory();
        var logs = Path.Combine(temp.Path, "state/logs/sessions");
        Directory.CreateDirectory(logs);
        await File.WriteAllTextAsync(
            Path.Combine(logs, "opaque.jsonl"),
            Legacy(message).ToJsonString() + "\n"
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            SqliteArchiveMessageStore.ImportLegacyAsync(temp.Path)
        );
    }
}
