using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    // Combined slots: one detection call, and every range lands at its own slot's offsets,
    // including after multibyte text and at a slot's last character.
    [Fact]
    public async Task Combined_detection_maps_ranges_back_to_each_slot()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice", "Bob");
        var redactor = new TextRedactor(Enumerable.Range(60, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            BatchBytes = 4096,
        };
        string[] texts = ["数据 🦊 Alice 在这里", "no names here", "Ask Bob", "Bob and Alice"];

        var found = await redactor.DetectBatchAsync(http, options, texts, default);

        Assert.Single(detector.Texts);
        Assert.Equal(string.Join(TextRedactor.BatchSeparator, texts), detector.Texts.Single());
        Assert.Equal(texts.Length, found.Length);
        for (var index = 0; index < texts.Length; index++)
        {
            var single = await redactor.DetectAsync(http, options, texts[index], default);
            Assert.Equal(
                single.Select(span => (span.Start, span.Length, span.Placeholder, span.Original)),
                found[index]
                    .Select(span => (span.Start, span.Length, span.Placeholder, span.Original))
            );
            foreach (var span in found[index])
                Assert.Equal(span.Original, texts[index].Substring(span.Start, span.Length));
        }
        Assert.Equal(["Alice"], found[0].Select(span => span.Original));
        Assert.Empty(found[1]);
        Assert.Equal(["Bob"], found[2].Select(span => span.Original));
        Assert.Equal(["Bob", "Alice"], found[3].Select(span => span.Original));
    }

    // A range that crosses the separator is clipped into each slot it covers; a clipped part
    // that is only whitespace is dropped.
    [Fact]
    public async Task Combined_detection_clips_a_range_that_crosses_slots()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Transform = response =>
        {
            var text = detector.Texts.Last();
            var bytes = Encoding.UTF8.GetBytes(text);
            // From "Alice" in the first slot to "Smith" in the second.
            var start = Encoding.UTF8.GetByteCount(
                text[..text.IndexOf("Alice", StringComparison.Ordinal)]
            );
            var end = Encoding.UTF8.GetByteCount(
                text[..(text.IndexOf("Smith", StringComparison.Ordinal) + 5)]
            );
            // A range covering only the separator and the third slot's leading spaces.
            var gap = Encoding.UTF8.GetByteCount(
                text[..text.LastIndexOf("\n\n", StringComparison.Ordinal)]
            );
            response["entities"] = new JsonArray
            {
                new JsonObject
                {
                    ["start"] = start,
                    ["end"] = end,
                    ["score"] = 0.9,
                    ["label"] = "private_person",
                },
                new JsonObject
                {
                    ["start"] = gap,
                    ["end"] = gap + 4,
                    ["score"] = 0.9,
                    ["label"] = "private_person",
                },
            };
            Assert.True(end <= bytes.Length);
            return response;
        };
        var redactor = new TextRedactor(Enumerable.Range(70, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);

        var found = await redactor.DetectBatchAsync(
            http,
            options,
            ["Hi Alice", "Smith wrote", "  later"],
            default
        );

        Assert.Equal([("Alice", 3)], found[0].Select(span => (span.Original, span.Start)));
        Assert.Equal([("Smith", 0)], found[1].Select(span => (span.Original, span.Start)));
        Assert.Empty(found[2]);
    }

    [Fact]
    public void Batches_group_texts_in_order_within_the_byte_limit()
    {
        string[] texts = ["aaaa", "bbbb", "cccccccccc", "dd", "ee"];

        Assert.Equal(
            [
                ["aaaa", "bbbb"],
                ["cccccccccc"],
                ["dd", "ee"],
            ],
            TextRedactionScope.Batches(texts, 10)
        );
        Assert.Equal(
            texts.Select(text => new List<string> { text }),
            TextRedactionScope.Batches(texts, 0)
        );
        // UTF-8 bytes, not characters: two 6-byte texts and a separator exceed 12.
        Assert.Equal(2, TextRedactionScope.Batches(["数据", "数据"], 12).Count);
        Assert.Single(TextRedactionScope.Batches(["数据", "数据"], 14));
    }

    // With batchBytes, a request combines its uncached slots, even at concurrency 1, and the
    // model sees the same redacted history.
    [Fact]
    public async Task Request_combines_uncached_slots_into_one_detection_call()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice", "Bob");
        var history = new[] { "Ask Alice", "Ask Bob", "Nothing", "Ask Alice" }
            .Select(text => ChatResult.Text(text).AssistantMessage!)
            .ToList();
        IReadOnlyList<JsonObject>? sent = null;
        var service = new TextRedactionChatService(
            ProviderHttpRequest.CreateClient(),
            new ResponsesClientOptions(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100)
            {
                Instructions = "Instructions",
                TextRedactorSource = () =>
                    new TextRedactor(Enumerable.Range(80, 32).Select(i => (byte)i).ToArray()),
            },
            new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000) { BatchBytes = 65536 },
            null,
            (_, _) => new CapturingChatService(value => sent = value)
        );

        await service.ChatAsync("s", history, default);

        Assert.Single(detector.Texts);
        var texts = sent!.Select(message => message.ToJsonString()).ToArray();
        Assert.DoesNotContain("Alice", string.Concat(texts));
        Assert.DoesNotContain("Bob", string.Concat(texts));
        Assert.Contains("Nothing", texts[2]);
        Assert.Equal(texts[0], texts[^1]);
    }

    // A combined call the service rejects as too large is retried slot by slot.
    [Fact]
    public async Task Too_large_combined_call_falls_back_to_single_slots()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice");
        detector.Intercept = async (context, text) =>
        {
            if (!text.Contains(TextRedactor.BatchSeparator, StringComparison.Ordinal))
                return false;
            context.Response.StatusCode = 413;
            await context.Response.WriteAsync("Input exceeds token limit");
            return true;
        };
        var history = new[] { "Ask Alice", "Second", "Third" }
            .Select(text => ChatResult.Text(text).AssistantMessage!)
            .ToList();
        IReadOnlyList<JsonObject>? sent = null;
        var service = new TextRedactionChatService(
            ProviderHttpRequest.CreateClient(),
            new ResponsesClientOptions(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100)
            {
                TextRedactorSource = () =>
                    new TextRedactor(Enumerable.Range(90, 32).Select(i => (byte)i).ToArray()),
            },
            new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000) { BatchBytes = 65536 },
            null,
            (_, _) => new CapturingChatService(value => sent = value)
        );

        await service.ChatAsync("s", history, default);

        // One rejected combined call, then each slot alone.
        Assert.Equal(4, detector.Texts.Count);
        Assert.DoesNotContain("Alice", sent![0].ToJsonString());
    }

    // A kept value is neither replaced where detected nor masked as a known value, while
    // other detections in the same text still are.
    [Fact]
    public async Task Kept_values_are_not_replaced_or_spread()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Acme", "Alice");
        var redactor = new TextRedactor(Enumerable.Range(100, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var keep = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KeepValues = ["acme"],
        };
        var scope = redactor.Begin(http, keep, default);

        var result = scope.MaskKnown(await scope.DetectAsync("Alice works at Acme"));

        Assert.Contains("Acme", result);
        Assert.DoesNotContain("Alice", result);
        Assert.DoesNotContain(scope.Registered.Values, value => value == "Acme");

        // Registered as a known value by a request without the list, then kept by one with it.
        var plain = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var first = redactor.Begin(http, plain, default);
        Assert.DoesNotContain("Acme", first.MaskKnown(await first.DetectAsync("Acme ships")));
        var later = redactor.Begin(http, keep, default);
        Assert.Equal("Acme again", later.MaskKnown("Acme again"));
    }

    // Foxwarm's own names stay even without a configured list: here the detector flags a
    // channel platform and an envelope tag name in envelope context.
    [Fact]
    public async Task Foxwarm_vocabulary_is_always_kept()
    {
        var platform = "web" + "ui";
        var tag = "foxwarm" + "-message";
        await using var detector = await TextDetectionPeer.StartAsync(platform, tag, "Alice");
        var redactor = new TextRedactor(Enumerable.Range(110, 32).Select(i => (byte)i).ToArray());
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var scope = redactor.Begin(http, options, default);
        var text = $"<{tag} type=\"channel\" channelType=\"{platform}\">Ask Alice</{tag}>";

        var result = scope.MaskKnown(await scope.DetectAsync(text));

        Assert.Contains($"<{tag} type=\"channel\" channelType=\"{platform}\">Ask ", result);
        Assert.EndsWith($"</{tag}>", result);
        Assert.DoesNotContain("Alice", result);
        Assert.DoesNotContain(scope.Registered.Values, value => value == platform || value == tag);
        Assert.True(options.Keeps("Foxwarm"));
        Assert.True(options.Keeps("foxwarm-system"));
        Assert.False(options.Keeps("foxwarm-"));
        Assert.False(options.Keeps("foxwarmer"));
    }

    [Fact]
    public void Keep_values_and_batch_bytes_parse_and_validate()
    {
        var options = TextRedactionOptions.FromResolved(
            JsonNode
                .Parse(
                    """{"enabled":true,"endpoint":"http://d/x","batchBytes":32768,"keepValues":[" Acme ","acme","Beta"]}"""
                )!
                .AsObject()
        )!;
        Assert.Equal(32768, options.BatchBytes);
        Assert.Equal(["Acme", "Beta"], options.KeepValues);
        Assert.NotEqual(options, options with { KeepValues = ["Acme"] });
        // Batch size does not change cache identity.
        Assert.Equal(options, options with { BatchBytes = 0 });
        foreach (
            var invalid in new[]
            {
                """{"batchBytes":-1}""",
                """{"batchBytes":262145}""",
                """{"batchBytes":1.5}""",
                """{"keepValues":"Acme"}""",
                """{"keepValues":[" "]}""",
                """{"keepValues":[1]}""",
            }
        )
            Assert.Throws<InvalidDataException>(() =>
                TextRedactionOptions.Validate(JsonNode.Parse(invalid))
            );
    }
}
