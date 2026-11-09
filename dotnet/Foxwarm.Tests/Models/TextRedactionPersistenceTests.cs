using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

// Restart persistence of per-slot results and known originals (`TextRedactionStore`).
public sealed class TextRedactionPersistenceTests
{
    private const string Early = "I am Alice; Bob joins later.";

    private static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static Task AnswerAsync(System.Net.Sockets.NetworkStream connection) =>
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
    private static async Task<TextDetectionPeer> DetectorAsync()
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

    // Several turns, then a new redactor over the same data root and instance key: the same
    // history is sent byte for byte without detection, although combined detection would see
    // other context and a later known value (Bob) would now mask the first message. New
    // slots keep being masked with the persisted known values; changed settings re-detect.
    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public async Task Restart_sends_the_same_history_without_detection(int batchBytes)
    {
        await using var detector = await DetectorAsync();
        await using var provider = new ScriptedResponsesSequenceServer(
            5,
            async (_, connection, _) => await AnswerAsync(connection)
        );
        using var http = ProviderHttpRequest.CreateClient();
        using var temp = new TempDirectory();
        var catalog = Catalog(provider.BaseUri, detector.Endpoint, batchBytes, 0.5);
        var first = User(Early);
        var bob = User("Bob is here.");
        string sent;
        JsonObject reply;
        using (var secrets = new InstanceSecrets(temp.Path))
        {
            reply = (
                await RequestAsync(http, provider.BaseUri, catalog, secrets, first)
            ).AssistantMessage!;
            await RequestAsync(http, provider.BaseUri, catalog, secrets, first, reply, bob);
            sent = (await provider.RequestAt(1)).Body;
            // The early message keeps the form it was first sent in; Bob is masked elsewhere.
            Assert.Contains("Bob joins later", sent);
            Assert.DoesNotContain("Bob", LastText(sent));
        }
        var calls = detector.Texts.Count;

        using (var restarted = new InstanceSecrets(temp.Path))
        {
            // The sent-version view reads the store after the restart, without the detector.
            var candidates = TextRedactionView.Candidates(catalog, "p/m");
            var view = TextRedactionView.Describe(first, candidates, restarted);
            Assert.Equal("available", view["state"]!.GetValue<string>());
            Assert.Equal(calls, detector.Texts.Count);

            var again = await RequestAsync(
                http,
                provider.BaseUri,
                catalog,
                restarted,
                first,
                reply,
                bob
            );
            Assert.Equal(sent, (await provider.RequestAt(2)).Body);
            Assert.Equal(calls, detector.Texts.Count);
            var meta = again.AssistantMessage!["__meta"]!["textRedaction"]!;
            Assert.Equal(0, meta["detectorCalls"]!.GetValue<int>());
            Assert.Equal(meta["slots"]!.GetValue<int>(), meta["cachedSlots"]!.GetValue<int>());

            // A new slot the detector misses is still masked with the known values from
            // before the restart.
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
            Assert.Equal("Ask " + restarted.TextRedactor().Placeholder("Bob"u8) + " again", masked);

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
    }

    // The store holds neither originals nor placeholders in readable form, and a copy without
    // the instance key yields nothing; with the key it is readable.
    [Fact]
    public async Task A_store_copied_without_the_key_cannot_be_read()
    {
        await using var detector = await DetectorAsync();
        using var http = ProviderHttpRequest.CreateClient();
        using var temp = new TempDirectory();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        string placeholder;
        using (var secrets = new InstanceSecrets(temp.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            var result = scope.MaskKnown(await scope.DetectAsync("Alice and Bob"));
            placeholder = secrets.TextRedactor().Placeholder("Alice"u8);
            Assert.Contains(placeholder, result);
        }
        var file = Path.Combine(temp.Path, "state", TextRedactionStore.FileName);
        var bytes = File.ReadAllBytes(file);
        foreach (var value in new[] { "Alice", "Bob", placeholder, TextRedactor.Prefix })
        {
            Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(value)));
            Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.Unicode.GetBytes(value)));
        }

        using var copy = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(copy.Path, "state"));
        File.Copy(file, Path.Combine(copy.Path, "state", TextRedactionStore.FileName));
        using (var foreign = new InstanceSecrets(copy.Path))
        {
            var redactor = foreign.TextRedactor();
            Assert.Equal(0, redactor.KnownCount);
            Assert.Null(redactor.Peek(options, "Alice and Bob"));
        }

        using var keyed = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(keyed.Path, "state"));
        Directory.CreateDirectory(Path.Combine(keyed.Path, "keys"));
        File.Copy(file, Path.Combine(keyed.Path, "state", TextRedactionStore.FileName));
        File.Copy(InstanceKeys.DefaultPath(temp.Path), InstanceKeys.DefaultPath(keyed.Path));
        using (var owner = new InstanceSecrets(keyed.Path))
        {
            var redactor = owner.TextRedactor();
            Assert.Equal(2, redactor.KnownCount);
            Assert.NotNull(redactor.Peek(options, "Alice and Bob"));
        }
    }

    // Records that do not fit the slot text are misses and are removed: out of range, not on
    // a character boundary, overlapping, or a literal range over a detected placeholder.
    [Fact]
    public void Invalid_records_are_ignored_and_removed()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1);
        const string text = "Hi 🦊 Alice";
        var placeholder = new TextRedactor(TextRedactionTests.Key).Placeholder("Alice"u8);
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
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        {
            var redactor = new TextRedactor(TextRedactionTests.Key, store: store);
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
        using var check = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + path);
        check.Open();
        using var count = check.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM slots";
        Assert.Equal(1L, (long)count.ExecuteScalar()!);
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch.AddDays(20000);

        public override DateTimeOffset GetUtcNow() => Now;
    }

    // Slot records are pruned least recently used first within their byte bound; a slot used
    // after it was written survives older ones.
    [Fact]
    public void Slot_records_are_bounded_least_recently_used_first()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        var clock = new Clock();
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1);
        string Text(int index) => "slot " + index;
        using var store = TextRedactionStore.Open(path, key, 1 << 20, clock, slotLimit: 5000)!;
        var redactor = new TextRedactor(TextRedactionTests.Key, store: store);
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

        var fresh = new TextRedactor(TextRedactionTests.Key, store: store);
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

    // Known originals mirror the bounded reverse map: evicted values are removed from disk, so
    // a restart restores the same set in the same order.
    [Fact]
    public void Known_values_mirror_the_bounded_reverse_map()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        var key = Enumerable.Range(0, 64).Select(i => (byte)i).ToArray();
        string[] before;
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        {
            var redactor = new TextRedactor(TextRedactionTests.Key, knownBytes: 2000, store: store);
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
        }
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        {
            var restarted = new TextRedactor(
                TextRedactionTests.Key,
                knownBytes: 2000,
                store: store
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
        var options = new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 1);
        return Enumerable
            .Range(0, 40)
            .Select(index => "Person" + index)
            .Where(original => redactor.FindKnown(snapshot, original, options).Count == 1)
            .ToArray();
    }

    // A store that cannot be opened leaves redaction working from memory; an unreadable file
    // is replaced.
    [Fact]
    public async Task An_unusable_store_does_not_fail_redaction()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice");
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);

        using var blocked = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(blocked.Path, "state", TextRedactionStore.FileName));
        using (var secrets = new InstanceSecrets(blocked.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            Assert.DoesNotContain("Alice", scope.MaskKnown(await scope.DetectAsync("Hi Alice")));
        }

        using var damaged = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(damaged.Path, "state"));
        var file = Path.Combine(damaged.Path, "state", TextRedactionStore.FileName);
        File.WriteAllBytes(file, Enumerable.Repeat((byte)0x5A, 8192).ToArray());
        using (var secrets = new InstanceSecrets(damaged.Path))
        {
            var scope = secrets.TextRedactor().Begin(http, options, default);
            Assert.DoesNotContain("Alice", scope.MaskKnown(await scope.DetectAsync("Hi Alice")));
        }
        using (var secrets = new InstanceSecrets(damaged.Path))
            Assert.Equal(1, secrets.TextRedactor().KnownCount);
    }
}
