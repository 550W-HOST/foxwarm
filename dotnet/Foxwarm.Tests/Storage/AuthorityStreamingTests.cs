using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class AuthorityStreamingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Complete_UTF8_values_match_document_serialization_in_bounded_writes(bool immutable)
    {
        var messages = Enumerable
            .Range(1, 320)
            .Select(index =>
            {
                var message = Fixture.Message(
                    index,
                    "café 漢字 🦊\n\t\"\\\u2028\u2029" + new string('x', 1600),
                    index * 1000
                );
                message["future"] = JsonNode.Parse(
                    "{\"n\":9007199254740993,\"exponent\":1e400,\"null\":null,\"array\":[true,false,{},[]]}"
                );
                return message;
            })
            .ToArray();
        var block = new ArchiveBlockRecord(
            Fixture.SessionId,
            "main",
            1,
            1,
            "message",
            1,
            2,
            null,
            1,
            2,
            1000,
            2000,
            "summary",
            null,
            3000
        ).ToMessage();
        messages[0] = block;
        var root = PersistencePrimitiveTests.FixtureAuthority(messages);
        root["futureState"] = new JsonObject { ["array"] = new JsonArray("opaque", 0.1m, null) };
        root["meta"]!["llmFailed"] = true;
        root["stats"]!["totalCost"] = 0.5;
        root["stats"]!["lastUsage"] = new JsonObject { ["cost"] = 0.5, ["future"] = "kept" };
        var document = SessionAuthorityDocument.FromNode(root, Fixture.SessionId);
        var expected = Encoding.UTF8.GetBytes(document.ToJson());
        using var output = new RecordingStream();
        if (immutable)
        {
            var state = (JsonObject)root.DeepClone();
            state["history"] = null;
            var history = SessionHistory.FromJson(messages);
            SessionAuthorityDocument.ValidateState(state, history.Count, Fixture.SessionId, "main");
            SessionAuthorityDocument.WriteTo(output, state, history);
        }
        else
            document.WriteTo(output);
        Assert.Equal(expected, output.ToArray());
        Assert.True(output.Writes > 1);
        Assert.True(output.LargestWrite < expected.Length / 2);
    }

    [Theory]
    [InlineData("role")]
    [InlineData("parts")]
    [InlineData("seq")]
    [InlineData("timestamp")]
    [InlineData("frontier")]
    [InlineData("block")]
    public async Task Invalid_immutable_history_never_replaces_complete_authority(string fault)
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var original = new SessionSnapshot(
            "s",
            [Fixture.Message(1, "original", 1000)],
            [],
            false,
            null,
            false,
            new(),
            2,
            0,
            new()
        );
        await store.CommitAsync(original, SaveKind.Strict);
        var previous = await File.ReadAllBytesAsync(store.AuthorityPath);
        var bad = Fixture.Message(2, "invalid", 2000);
        switch (fault)
        {
            case "role":
                bad["role"] = "unknown";
                break;
            case "parts":
                bad["parts"] = new JsonArray(1);
                break;
            case "seq":
                bad["__meta"]!["seq"] = 0;
                break;
            case "timestamp":
                bad["__meta"]!["timestamp"] = JsonNode.Parse("1e400");
                break;
            case "frontier":
                bad["__meta"]!["contextFrontierItem"] = null;
                break;
            case "block":
                bad["__meta"]!["contextBlock"] = new JsonObject();
                break;
        }
        var invalid = original with
        {
            History = original.History.AppendJson([bad]),
            NextMessageSeq = 3,
        };
        var error = await Record.ExceptionAsync(() => store.CommitAsync(invalid, SaveKind.Strict));
        Assert.True(error is InvalidDataException or UnsupportedSessionAuthorityException);
        Assert.Equal(previous, await File.ReadAllBytesAsync(store.AuthorityPath));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(store.AuthorityPath)!, "*.tmp-*"));
        Assert.Single(
            (await new PersistentSessionAuthorityStore(temp.Path, "s").LoadAsync("s"))!.History
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Unwritable_unknown_values_keep_the_existing_serialization_failure_boundary(
        bool inHistory
    )
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var original = new SessionSnapshot(
            "s",
            [Fixture.Message(1, "original", 1000)],
            [],
            false,
            null,
            false,
            new(),
            2,
            0,
            new()
        );
        await store.CommitAsync(original, SaveKind.Strict);
        var previous = await File.ReadAllBytesAsync(store.AuthorityPath);
        var nested = new JsonObject();
        var leaf = nested;
        for (var index = 0; index < 65; index++)
        {
            var child = new JsonObject();
            leaf["next"] = child;
            leaf = child;
        }
        var root = PersistencePrimitiveTests.FixtureAuthority();
        if (inHistory)
            root["history"]![0]!["future"] = nested;
        else
            root["future"] = nested;
        var document = SessionAuthorityDocument.FromNode(root, Fixture.SessionId);
        Assert.Throws<InvalidOperationException>(() => document.ToJson());
        using var output = new MemoryStream();
        Assert.Throws<InvalidOperationException>(() => document.WriteTo(output));

        SessionSnapshot invalid;
        if (inHistory)
        {
            // Immutable ingress can own a deep element independently of serializer admission.
            // Its active-file depth still has to obey the same full-document writer limit.
            var json =
                "{\"role\":\"user\",\"parts\":[],\"__meta\":{\"seq\":1,\"timestamp\":1000},\"future\":"
                + new string('[', 65)
                + "0"
                + new string(']', 65)
                + "}";
            using var parsed = JsonDocument.Parse(
                json,
                new JsonDocumentOptions { MaxDepth = 1000 }
            );
            invalid = original with
            {
                History = SessionHistory.FromMessages([
                    HistoryMessage.FromElement(parsed.RootElement),
                ]),
            };
        }
        else
        {
            invalid = original with
            {
                AuthorityEnvelope = new JsonObject { ["future"] = nested.DeepClone() },
            };
        }
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            store.CommitAsync(invalid, SaveKind.Strict)
        );
        Assert.Equal(previous, await File.ReadAllBytesAsync(store.AuthorityPath));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(store.AuthorityPath)!, "*.tmp-*"));
    }

    [Fact]
    public void Mid_stream_failure_discards_partial_temp_and_leaves_previous_file()
    {
        using var temp = new TempDirectory();
        var file = new LinuxAtomicJsonFile(temp.Path, "state/authority.json");
        var document = SessionAuthorityDocument.FromNode(
            PersistencePrimitiveTests.FixtureAuthority(),
            Fixture.SessionId
        );
        file.Write(document);
        var previous = File.ReadAllBytes(file.FilePath);
        Assert.Throws<IOException>(() =>
            file.WriteStreamPayload(
                stream =>
                {
                    stream.Write(Encoding.UTF8.GetBytes("{\"partial\":"));
                    throw new IOException("owned interrupted stream");
                },
                default
            )
        );
        Assert.Equal(previous, File.ReadAllBytes(file.FilePath));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(file.FilePath)!, "*.tmp-*"));
    }

    private sealed class RecordingStream : MemoryStream
    {
        public int Writes { get; private set; }
        public int LargestWrite { get; private set; }

        public override void Write(byte[] buffer, int offset, int count)
        {
            Writes++;
            LargestWrite = Math.Max(LargestWrite, count);
            base.Write(buffer, offset, count);
        }
    }
}
