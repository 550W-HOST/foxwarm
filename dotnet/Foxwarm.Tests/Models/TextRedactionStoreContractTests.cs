using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

/// <summary>
/// Persistence of per-slot results and known originals that every
/// <see cref="ITextRedactionStore"/> backend shares (moved from TextRedactionPersistenceTests).
/// A hand-over is a restart on files and an owner change (a takeover at a new lease epoch)
/// on PostgreSQL; either way the next owner must send unchanged history byte for byte
/// (D-request-prefix-stability).
/// </summary>
public abstract class TextRedactionStoreContractTests
{
    internal const string Early = "I am Alice; Bob joins later.";

    private protected abstract Task<Owner> CreateAsync();

    /// <summary>The current owner of one installation's redaction cache.</summary>
    private protected abstract class Owner : IAsyncDisposable
    {
        private readonly List<ITextRedactionStore> opened = [];
        private readonly TempDirectory temp = new();

        /// <summary>The data root holding the instance key.</summary>
        internal string DataRoot => temp.Path;

        /// <summary>Instance secrets of the current owner with all labels known.</summary>
        internal InstanceSecrets Secrets()
        {
            var secrets = new InstanceSecrets(
                DataRoot,
                openTextRedaction: key =>
                {
                    var store = OpenStore(key, knownLimit: TextRedactor.DefaultKnownBytes);
                    lock (opened)
                        opened.Add(store);
                    return store;
                }
            );
            secrets.SetTextRedactionKnownLabels(TextRedactionKnownLabels.All);
            return secrets;
        }

        /// <summary>
        /// Writes what the current owner's stores have pending, then hands the installation to
        /// the next owner.
        /// </summary>
        internal async Task HandOverAsync()
        {
            lock (opened)
                foreach (var store in opened)
                    store.Flush();
            await ChangeOwnerAsync();
        }

        private protected abstract Task ChangeOwnerAsync();

        internal abstract TextRedactionRecordStore OpenStore(
            byte[] key,
            TimeProvider? clock = null,
            long slotLimit = TextRedactionRecordStore.DefaultSlotBytes,
            long knownLimit = 1 << 20
        );

        internal abstract long SlotCount();

        public virtual ValueTask DisposeAsync()
        {
            temp.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    internal static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    internal static Task AnswerAsync(System.Net.Sockets.NetworkStream connection) =>
        LoopbackResponsesServer.WriteResponseAsync(
            connection,
            200,
            "application/json",
            Encoding.UTF8.GetBytes(
                """{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}"""
            )
        );

    // Alice and Bob are names, but in context the detector misses Bob in texts that say he
    // joins "later" and finds nothing in texts that say "again".
    internal static async Task<TextDetectionPeer> DetectorAsync()
    {
        var detector = await TextDetectionPeer.StartAsync("Alice", "Bob");
        detector.Intercept = async (context, text) =>
        {
            if (!text.Contains("later", StringComparison.Ordinal) && !text.Contains("again"))
                return false;
            var entities = new JsonArray();
            var index = text.IndexOf("Alice", StringComparison.Ordinal);
            if (index >= 0 && !text.Contains("again", StringComparison.Ordinal))
            {
                var start = Encoding.UTF8.GetByteCount(text[..index]);
                entities.Add(
                    new JsonObject
                    {
                        ["start"] = start,
                        ["end"] = start + 5,
                        ["score"] = 0.9,
                        ["label"] = "private_person",
                    }
                );
            }
            await context.Response.WriteAsJsonAsync(
                new JsonObject
                {
                    ["entities"] = entities,
                    ["offset_unit"] = "utf8_bytes",
                    ["input_bytes"] = Encoding.UTF8.GetByteCount(text),
                    ["input_tokens"] = text.Length,
                }
            );
            return true;
        };
        return detector;
    }

    private static HostModels Catalog(
        Uri provider,
        Uri detector,
        int batchBytes,
        double threshold
    ) =>
        HostModels.Parse(
            new JsonObject
            {
                ["defaults"] = new JsonObject
                {
                    ["textRedaction"] = new JsonObject { ["knownLabels"] = "all" },
                },
                ["providers"] = new JsonObject
                {
                    ["p"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = provider.ToString(),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                        ["models"] = new JsonArray("m"),
                        ["textRedaction"] = new JsonObject
                        {
                            ["enabled"] = true,
                            ["endpoint"] = detector.ToString(),
                            ["batchBytes"] = batchBytes,
                            ["threshold"] = threshold,
                        },
                    },
                },
            },
            new()
        );

    private static Task<ChatResult> RequestAsync(
        HttpClient http,
        Uri provider,
        HostModels catalog,
        InstanceSecrets secrets,
        params JsonObject[] history
    ) =>
        new ModelRequestOwner(
            http,
            new(provider, "m", "p/m", "", "", 100),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: secrets
        ).RequestAsync(
            "s",
            catalog,
            "p/m",
            null,
            "cache",
            "turn",
            history,
            (_, _) => Task.FromResult("Instructions for Alice"),
            null,
            null,
            null,
            null,
            default
        );

    private static string LastText(string body)
    {
        var content = JsonNode.Parse(body)!["messages"]!.AsArray()[^1]!["content"]!;
        return content is JsonValue value
            ? value.GetValue<string>()
            : string.Concat(content.AsArray().Select(block => (string?)block?["text"]));
    }

    // Several turns, then a new owner with the same instance key: the same history is sent
    // byte for byte without detection, although combined detection would see other context
    // and a later known value (Bob) would now mask the first message. New slots keep being
    // masked with the persisted known values; changed settings re-detect.
    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public async Task A_new_owner_sends_the_same_history_without_detection(int batchBytes)
    {
        await using var detector = await DetectorAsync();
        await using var provider = new ScriptedResponsesSequenceServer(
            5,
            async (_, connection, _) => await AnswerAsync(connection)
        );
        using var http = ProviderHttpRequest.CreateClient();
        await using var owner = await CreateAsync();
        var catalog = Catalog(provider.BaseUri, detector.Endpoint, batchBytes, 0.5);
        var first = User(Early);
        var bob = User("Bob is here.");
        string sent;
        JsonObject reply;
        var previous = owner.Secrets();
        var placeholderBefore = previous.TextRedactor().Placeholder("Bob"u8);
        reply = (await RequestAsync(http, provider.BaseUri, catalog, previous, first)).AssistantMessage!;
        await RequestAsync(http, provider.BaseUri, catalog, previous, first, reply, bob);
        sent = (await provider.RequestAt(1)).Body;
        // The early message keeps the form it was first sent in; Bob is masked elsewhere.
        Assert.Contains("Bob joins later", sent);
        Assert.DoesNotContain("Bob", LastText(sent));
        var calls = detector.Texts.Count;
        await owner.HandOverAsync();
        previous.Dispose();

        using var restarted = owner.Secrets();
        // The sent-version view reads the store after the hand-over, without the detector.
        var candidates = TextRedactionView.Candidates(catalog, "p/m");
        var view = TextRedactionView.Describe(first, candidates, restarted);
        Assert.Equal("available", view["state"]!.GetValue<string>());
        Assert.Equal(calls, detector.Texts.Count);

        var again = await RequestAsync(http, provider.BaseUri, catalog, restarted, first, reply, bob);
        Assert.Equal(sent, (await provider.RequestAt(2)).Body);
        Assert.Equal(calls, detector.Texts.Count);
        var meta = again.AssistantMessage!["__meta"]!["textRedaction"]!;
        Assert.Equal(0, meta["detectorCalls"]!.GetValue<int>());
        Assert.Equal(meta["slots"]!.GetValue<int>(), meta["cachedSlots"]!.GetValue<int>());

        // A new slot the detector misses is still masked with the known values from before
        // the hand-over, with the same placeholder.
        await RequestAsync(
            http,
            provider.BaseUri,
            catalog,
            restarted,
            first,
            reply,
            bob,
            again.AssistantMessage!,
            User("Ask Bob again")
        );
        var masked = LastText((await provider.RequestAt(3)).Body);
        Assert.Equal(placeholderBefore, restarted.TextRedactor().Placeholder("Bob"u8));
        Assert.Equal("Ask " + placeholderBefore + " again", masked);

        // Changed settings are a new cache identity: everything is detected again.
        var changed = Catalog(provider.BaseUri, detector.Endpoint, batchBytes, 0.6);
        Assert.Equal(
            "unavailable",
            TextRedactionView.Describe(
                first,
                TextRedactionView.Candidates(changed, "p/m"),
                restarted
            )["state"]!.GetValue<string>()
        );
        calls = detector.Texts.Count;
        await RequestAsync(http, provider.BaseUri, changed, restarted, first, reply, bob);
        Assert.True(detector.Texts.Count > calls);
    }

    // Records that do not fit the slot text are misses and are removed: out of range, not on
    // a character boundary, overlapping, or a literal range over a detected placeholder.
    [Fact]
    public async Task Invalid_records_are_ignored_and_removed()
    {
        await using var owner = await CreateAsync();
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        const string text = "Hi 🦊 Alice";
        var placeholder = new TextRedactor(
            TextRedactionTests.Key,
            knownLabels: TextRedactionKnownLabels.All
        ).Placeholder("Alice"u8);
        TextRedactor.Found Span(int start, int length) =>
            new(
                start,
                length,
                "unused",
                text.Substring(start, Math.Min(length, text.Length - start)),
                ["private_person"]
            );
        var cases = new (TextRedactor.Found[] Spans, TextRedactor.Found[] Masked)[]
        {
            ([new(7, 9, "", "", ["x"])], []),
            ([Span(4, 1)], []),
            ([Span(6, 5), Span(8, 3)], []),
            ([Span(6, 5)], [new(6, 4, "", "", ["x"])]),
            ([new(6, 5, "", "", [])], []),
        };
        using (var store = owner.OpenStore(key))
        {
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            );
            // Each case under its own cache identity.
            for (var index = 0; index < cases.Length; index++)
                store.PutSlot(
                    options with
                    {
                        TimeoutMs = options.TimeoutMs + 1 + index,
                    },
                    TextRedactor.Digest(text),
                    cases[index].Spans,
                    cases[index].Masked
                );
            // A valid record for comparison.
            store.PutSlot(options, TextRedactor.Digest(text), [Span(6, 5)], []);
            store.Flush();
            for (var index = 0; index < cases.Length; index++)
                Assert.Null(
                    redactor.Peek(options with { TimeoutMs = options.TimeoutMs + 1 + index }, text)
                );
            var valid = redactor.Peek(options, text);
            Assert.Equal(
                [(6, 5, "Alice", placeholder)],
                valid!.Value.Spans.Select(span =>
                    (span.Start, span.Length, span.Original, span.Placeholder)
                )
            );
            store.Flush();
        }
        Assert.Equal(1L, owner.SlotCount());
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch.AddDays(20000);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    // Slot records are pruned least recently used first within their byte bound; a slot used
    // after it was written survives older ones.
    [Fact]
    public async Task Slot_records_are_bounded_least_recently_used_first()
    {
        await using var owner = await CreateAsync();
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        var clock = new Clock();
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        string Text(int index) => "slot " + index;
        using var store = owner.OpenStore(key, clock, slotLimit: 5000);
        var redactor = new TextRedactor(
            TextRedactionTests.Key,
            store: store,
            knownLabels: TextRedactionKnownLabels.All
        );
        for (var index = 0; index < 30; index++)
            store.PutSlot(options, TextRedactor.Digest(Text(index)), [], []);
        store.Flush();
        clock.Now = clock.Now.AddDays(1);
        // Served from the store, then from memory: the record is used today.
        Assert.NotNull(redactor.Cached(options, Text(0), TextRedactor.Digest(Text(0))));
        Assert.NotNull(redactor.Cached(options, Text(0), TextRedactor.Digest(Text(0))));
        store.Flush();
        clock.Now = clock.Now.AddDays(1);
        for (var index = 30; index < 60; index++)
        {
            store.PutSlot(options, TextRedactor.Digest(Text(index)), [], []);
            store.Flush();
        }

        var fresh = new TextRedactor(
            TextRedactionTests.Key,
            store: store,
            knownLabels: TextRedactionKnownLabels.All
        );
        Assert.NotNull(fresh.Peek(options, Text(0)));
        for (var index = 30; index < 60; index++)
            Assert.NotNull(fresh.Peek(options, Text(index)));
        // Pruning keeps 35 to 39 records here; only unused older ones were removed.
        Assert.InRange(
            Enumerable.Range(1, 29).Count(index => fresh.Peek(options, Text(index)) is not null),
            4,
            8
        );
    }

    // Known originals mirror the bounded reverse map: evicted values are removed from the
    // store, so the next owner restores the same set in the same order.
    [Fact]
    public async Task Known_values_mirror_the_bounded_reverse_map()
    {
        await using var owner = await CreateAsync();
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        string[] before;
        using (var store = owner.OpenStore(key))
        {
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                knownBytes: 2000,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            );
            for (var index = 0; index < 40; index++)
            {
                var original = "Person" + index;
                Assert.True(
                    redactor.TryRegister(
                        redactor.Placeholder(Encoding.UTF8.GetBytes(original)),
                        original,
                        ["private_person"]
                    )
                );
            }
            Assert.InRange(redactor.KnownCount, 1, 39);
            before = Originals(redactor);
            store.Flush();
        }
        await owner.HandOverAsync();
        using (var store = owner.OpenStore(key))
        {
            var restarted = new TextRedactor(
                TextRedactionTests.Key,
                knownBytes: 2000,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            );
            Assert.Equal(before, Originals(restarted));
            // Restored values are known for collision checks and literal masking.
            Assert.False(
                restarted.TryRegister(
                    restarted.Placeholder(Encoding.UTF8.GetBytes(before[^1])),
                    "someone else",
                    ["private_person"]
                )
            );
        }
    }

    private static string[] Originals(TextRedactor redactor)
    {
        var snapshot = redactor.KnownSnapshot();
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        return Enumerable
            .Range(0, 40)
            .Select(index => "Person" + index)
            .Where(original => redactor.FindKnown(snapshot, original, options).Count == 1)
            .ToArray();
    }
}

public sealed class FileTextRedactionStoreContractTests : TextRedactionStoreContractTests
{
    private protected override Task<Owner> CreateAsync() => Task.FromResult<Owner>(new Files());

    private sealed class Files : Owner
    {
        private string Path => System.IO.Path.Combine(DataRoot, "state", TextRedactionStore.FileName);

        private protected override Task ChangeOwnerAsync() => Task.CompletedTask;

        internal override TextRedactionRecordStore OpenStore(
            byte[] key,
            TimeProvider? clock = null,
            long slotLimit = TextRedactionRecordStore.DefaultSlotBytes,
            long knownLimit = 1 << 20
        ) => TextRedactionStore.Open(Path, key, knownLimit, clock, slotLimit)!;

        internal override long SlotCount()
        {
            using var check = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + Path + ";Pooling=False");
            check.Open();
            using var count = check.CreateCommand();
            count.CommandText = "SELECT COUNT(*) FROM slots";
            return (long)count.ExecuteScalar()!;
        }
    }
}
