using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class SessionAuthorityRetentionTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Cold_load_and_registry_restore_detach_all_nonhistory_branches_from_history_backing_buffers()
    {
        using var temp = new TempDirectory();
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var messages = Enumerable
            .Range(1, 68)
            .Select(sequence => new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = new string('h', 16384) }),
                ["__meta"] = new JsonObject { ["seq"] = sequence, ["timestamp"] = sequence },
            })
            .ToArray();
        var queued = JsonNode
            .Parse(
                """
                {"type":"user","parts":[{"text":"queued","futurePart":{"keep":true}}],
                 "message":{"role":"user","parts":[{"text":"prebuilt"}]},
                 "source":{"platform":"synthetic","channelUserId":"owned","futureSource":[null,1.2300e-7]},
                 "futureQueue":{"values":[null,false,9007199254740993]}}
                """
            )!
            .AsObject();
        var initial = new SessionSnapshot(
            "s",
            SessionHistory.FromJson(messages),
            [PersistentSessionAuthorityStore.FromQueueJson(queued)],
            false,
            null,
            false,
            JsonNode
                .Parse(
                    """{"futureMeta":{"values":["small",null,1.2300e-7]},"wait":{"id":"owned-wait","startedAt":1,"waitForInput":true,"declarationVersion":1}}"""
                )!
                .AsObject(),
            69,
            0,
            JsonNode
                .Parse(
                    """{"futureTop":{"values":["small",null,true,9007199254740993]},"persistentMemorySnapshot":"small snapshot"}"""
                )!
                .AsObject()
        );
        await store.CommitCanonicalAppendAsync(initial, messages);
        var file = Path.Combine(temp.Path, "state", "sessions", "s.json");
        var fileBytes = new FileInfo(file).Length;
        var loaded = (await store.LoadAsync("s"))!;
        var registry = new SessionRegistry(store, new ControlledChat());
        var entry = registry.Add("s", loaded);
        var restored = entry.Snapshot();
        var envelope = Buffers(restored.AuthorityEnvelope);
        var meta = Buffers(restored.Meta);
        var queue = Buffers(QueueNodes(restored.Queue));
        var history = Buffers(restored.History.Select(message => message.Data));
        var nonhistory = envelope
            .Concat(meta)
            .Concat(queue)
            .ToHashSet(ReferenceEqualityComparer.Instance);
        output.WriteLine(
            $"Authority file: {fileBytes} bytes; retained UTF-8 backing arrays: envelope={Bytes(envelope)}, meta={Bytes(meta)}, queue={Bytes(queue)}, nonhistory union={Bytes(nonhistory)}, history={Bytes(history)}."
        );
        Assert.True(fileBytes > 1_000_000);
        Assert.True(Bytes(history) > 1_000_000);
        Assert.InRange(Bytes(nonhistory), 1, 32768);
        Assert.Empty(nonhistory.Intersect(history, ReferenceEqualityComparer.Instance));
        Assert.True(
            JsonNode.DeepEquals(
                initial.AuthorityEnvelope["futureTop"],
                restored.AuthorityEnvelope["futureTop"]
            )
        );
        Assert.True(JsonNode.DeepEquals(initial.Meta["futureMeta"], restored.Meta["futureMeta"]));
        Assert.True(
            JsonNode.DeepEquals(
                queued,
                PersistentSessionAuthorityStore.ToQueueJson(restored.Queue[0])
            )
        );
        Assert.Equal(
            initial.History.Select(row => row.ToJsonString()),
            restored.History.Select(row => row.ToJsonString())
        );

        // Restore and ordinary snapshots share immutable history roots, but isolate mutable values.
        Assert.Same(loaded.History, restored.History);
        Assert.Same(restored.History, entry.Snapshot().History);
        Assert.Same(restored.History[0], entry.Snapshot().History.First());
        loaded.Meta["futureMeta"]!["values"]![0] = "changed caller";
        loaded.AuthorityEnvelope["futureTop"]!["values"]![0] = "changed caller";
        loaded.Queue[0].Source!.OpenFields!["futureSource"]![0] = "changed caller";
        restored.Meta["futureMeta"]!["values"]![0] = "changed snapshot";
        restored.AuthorityEnvelope["futureTop"]!["values"]![0] = "changed snapshot";
        restored.Queue[0].Parts![0]["text"] = "changed snapshot";
        var unchanged = entry.Snapshot();
        Assert.Equal("small", unchanged.Meta["futureMeta"]!["values"]![0]!.GetValue<string>());
        Assert.Equal(
            "small",
            unchanged.AuthorityEnvelope["futureTop"]!["values"]![0]!.GetValue<string>()
        );
        Assert.True(
            JsonNode.DeepEquals(
                queued,
                PersistentSessionAuthorityStore.ToQueueJson(unchanged.Queue[0])
            )
        );
        await entry.SaveLane.SaveStrictAsync();
        var reopenedRegistry = new SessionRegistry(
            new PersistentSessionAuthorityStore(temp.Path, "s"),
            new ControlledChat()
        );
        var reopened = (await reopenedRegistry.LoadOrAddAsync("s")).Snapshot();
        Assert.True(JsonNode.DeepEquals(unchanged.Meta, reopened.Meta));
        Assert.True(JsonNode.DeepEquals(unchanged.AuthorityEnvelope, reopened.AuthorityEnvelope));
        Assert.True(
            JsonNode.DeepEquals(
                queued,
                PersistentSessionAuthorityStore.ToQueueJson(reopened.Queue[0])
            )
        );
        Assert.Equal(
            unchanged.History.Select(row => row.ToJsonString()),
            reopened.History.Select(row => row.ToJsonString())
        );
        Assert.InRange(
            Bytes(
                Buffers(reopened.AuthorityEnvelope)
                    .Concat(Buffers(reopened.Meta))
                    .Concat(Buffers(QueueNodes(reopened.Queue)))
                    .ToHashSet(ReferenceEqualityComparer.Instance)
            ),
            1,
            32768
        );
    }

    private static IEnumerable<JsonNode?> QueueNodes(IReadOnlyList<QueueItem> queue) =>
        queue.SelectMany(item =>
            new JsonNode?[] { item.OpenFields, item.Message, item.Source?.OpenFields }.Concat(
                item.Parts ?? []
            )
        );

    // Inspect the actual immutable JSON document -> UTF-8 array edges, not allocations or GC/RSS.
    // Enumerating containers exposes their retained leaves without serializing them into new documents.
    private static HashSet<object> Buffers(params JsonNode?[] roots) =>
        Buffers((IEnumerable<JsonNode?>)roots);

    private static HashSet<object> Buffers(IEnumerable<JsonNode?> roots)
    {
        IEnumerable<JsonElement> Elements(JsonNode? node)
        {
            if (node is JsonObject obj)
                return obj.SelectMany(pair => Elements(pair.Value));
            if (node is JsonArray array)
                return array.SelectMany(Elements);
            return node is JsonValue value && value.TryGetValue<JsonElement>(out var element)
                ? [element]
                : [];
        }
        return Buffers(roots.SelectMany(Elements));
    }

    private static HashSet<object> Buffers(IEnumerable<JsonElement> elements)
    {
        var result = new HashSet<object>(ReferenceEqualityComparer.Instance);
        var parentField = typeof(JsonElement).GetField(
            "_parent",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!;
        var bytesField = typeof(JsonDocument).GetField(
            "_utf8Json",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!;
        foreach (var element in elements)
        {
            var document = parentField.GetValue(element)!;
            var memory = (ReadOnlyMemory<byte>)bytesField.GetValue(document)!;
            Assert.True(MemoryMarshal.TryGetArray(memory, out var segment));
            result.Add(segment.Array!);
        }
        return result;
    }

    private static long Bytes(IEnumerable<object> arrays) =>
        arrays.Sum(array => ((byte[])array).LongLength);
}
