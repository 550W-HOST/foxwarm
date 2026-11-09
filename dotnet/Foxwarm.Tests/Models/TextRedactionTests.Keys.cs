using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    [Fact]
    public async Task Hmac_placeholders_are_short_and_stable_for_one_instance_key()
    {
        const string value = "alice@example.test";
        await using var detector = await TextDetectionPeer.StartAsync(value);
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        using var keys = new TextRedactionKeys();
        var first = await new TextRedactor(keys.Secrets.TextRedactionPlaceholderKey())
            .Begin(http, options, default)
            .RedactAsync(value);
        Assert.Matches(new Regex(@"^\[\[PRIVATE_[0-9a-f]{16}\]\]$"), first);
        Assert.DoesNotContain("FW_SECRET", first);
        Assert.NotEqual(
            TextRedactor.Prefix
                + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..16]
                + "]]",
            first
        );

        // A restarted Main opens the same key file and derives the same placeholder key.
        using (var restarted = new InstanceSecrets(keys.DataRoot))
        {
            var key = restarted.TextRedactionPlaceholderKey();
            Assert.Equal(
                first,
                await new TextRedactor(key).Begin(http, options, default).RedactAsync(value)
            );
            Assert.Same(restarted.TextRedactor(), restarted.TextRedactor());
        }
        Assert.Equal(
            await new TextRedactor(Key).Begin(http, options, default).RedactAsync(value),
            await new TextRedactor(Key).Begin(http, options, default).RedactAsync(value)
        );
        using var otherInstance = new TextRedactionKeys();
        var other = await new TextRedactor(otherInstance.Secrets.TextRedactionPlaceholderKey())
            .Begin(http, options, default)
            .RedactAsync(value);
        Assert.NotEqual(first, other);
        Assert.NotEqual(
            await new TextRedactor(Key).Begin(http, options, default).RedactAsync(value),
            await new TextRedactor(OtherKey).Begin(http, options, default).RedactAsync(value)
        );
        Assert.NotEqual(
            Convert.ToHexString(keys.Secrets.TextRedactionPlaceholderKey()),
            Convert.ToHexString(
                InstanceKeys
                    .OpenOrCreate(InstanceKeys.DefaultPath(keys.DataRoot))
                    .Derive(InstanceKeys.SecretStorePurpose)
            )
        );
    }

    [Fact]
    public async Task Placeholder_collisions_fail_closed_without_replacing_the_registered_value()
    {
        // A one-character digest makes collisions easy to construct.
        var redactor = new TextRedactor(Key, digestCharacters: 1);
        var byPlaceholder = new Dictionary<string, string>(StringComparer.Ordinal);
        string? first = null;
        string? second = null;
        for (var index = 0; first is null; index++)
        {
            var candidate = "person-" + index;
            var placeholder = redactor.Placeholder(Encoding.UTF8.GetBytes(candidate));
            if (byPlaceholder.TryGetValue(placeholder, out var earlier))
                (first, second) = (earlier, candidate);
            else
                byPlaceholder[placeholder] = candidate;
        }
        await using var detector = await TextDetectionPeer.StartAsync(first, second!);
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        var scope = redactor.Begin(http, options, default);
        var redacted = await scope.RedactAsync("to " + first);
        var failure = await Assert.ThrowsAsync<TextRedactionException>(() =>
            redactor.Begin(http, options, default).RedactAsync("to " + second)
        );
        Assert.False(failure.Retryable);
        Assert.Contains("collision", failure.Message);
        Assert.Equal("to " + first, scope.Restore(redacted));
        // The failed text was not cached as a successful detection.
        await Assert.ThrowsAsync<TextRedactionException>(() =>
            redactor.Begin(http, options, default).RedactAsync("to " + second)
        );
        Assert.Equal(3, detector.Texts.Count);
    }

    [Fact]
    public async Task Unavailable_instance_key_fails_enabled_requests_before_detection_or_send()
    {
        await using var detector = await TextDetectionPeer.StartAsync("input");
        using var http = ProviderHttpRequest.CreateClient();
        var catalog = Catalog(detector.Endpoint, new("http://127.0.0.1:1"));
        using var temp = new TempDirectory();
        // An existing store whose key file is missing is locked; no replacement key is minted.
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "state", "secrets.json"), "{}");
        using var locked = new InstanceSecrets(temp.Path);
        Assert.ThrowsAny<Exception>(() => locked.TextRedactionPlaceholderKey());
        foreach (var secrets in new[] { locked, null })
        {
            var owner = new ModelRequestOwner(
                http,
                new(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100),
                new(),
                (_, _) => throw new Exception("Unexpected retry"),
                secrets: secrets
            );
            var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
                owner.RequestAsync(
                    "s",
                    catalog,
                    "p/m",
                    null,
                    "cache",
                    "turn",
                    [ChatResult.Text("input").AssistantMessage!],
                    (_, _) => Task.FromResult(""),
                    null,
                    () => throw new Exception("Unexpected provider send"),
                    null,
                    null,
                    default
                )
            );
            Assert.Equal("text-redaction", error.Final.Kind);
            Assert.Equal(1, error.Final.Attempt);
            Assert.Contains("instance key", error.Final.Reason);
        }
        Assert.Empty(detector.Texts);
        Assert.False(File.Exists(InstanceKeys.DefaultPath(temp.Path)));
    }

    [Fact]
    public async Task Excluded_labels_default_to_dates_and_urls_and_replace_inherited_lists()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = """
                defaults:
                  textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify'}
                providers:
                  p:
                    baseUrl: http://127.0.0.1:2
                    models: [inherited, {id: none, textRedaction: {excludeLabels: []}}]
                  q:
                    baseUrl: http://127.0.0.1:2
                    textRedaction: {excludeLabels: [private_person, ' Private_Date ', PRIVATE_PERSON]}
                    models: [listed, {id: again, textRedaction: {threshold: 0.6}}]
                """,
            }
        );
        var catalog = configuration.Capture();
        TextRedactionOptions Resolve(string key) =>
            TextRedactionOptions.FromResolved(
                catalog.Resolve(key).Configuration["textRedaction"]!.AsObject()
            )!;
        Assert.Equal(new[] { "private_date", "private_url" }, Resolve("p/inherited").ExcludeLabels);
        Assert.Empty(Resolve("p/none").ExcludeLabels);
        Assert.Equal(new[] { "private_date", "private_person" }, Resolve("q/listed").ExcludeLabels);
        Assert.Equal(new[] { "private_date", "private_person" }, Resolve("q/again").ExcludeLabels);
        Assert.Equal(Resolve("q/listed") with { Threshold = .6 }, Resolve("q/again"));
        foreach (var invalid in new[] { "\"private_url\"", "[\"\"]", "[1]", "null" })
            Assert.Throws<InvalidDataException>(() =>
                HostModels.Parse(
                    JsonNode
                        .Parse(
                            "{\"providers\":{\"p\":{\"textRedaction\":{\"excludeLabels\":"
                                + invalid
                                + "}}}}"
                        )!
                        .AsObject(),
                    new()
                )
            );

        const string text = "On 2026-11-09 open https://example.test/x and mail bob@example.test.";
        await using var detector = await TextDetectionPeer.StartAsync(
            "2026-11-09",
            "https://example.test/x",
            "bob@example.test"
        );
        detector.Labels["2026-11-09"] = "PRIVATE_DATE";
        detector.Labels["https://example.test/x"] = "private_url";
        detector.Labels["bob@example.test"] = "private_email";
        using var http = ProviderHttpRequest.CreateClient();
        var redactor = new TextRedactor(Key);
        var defaults = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        var kept = await redactor.Begin(http, defaults, default).RedactAsync(text);
        Assert.Contains("2026-11-09", kept);
        Assert.Contains("https://example.test/x", kept);
        Assert.DoesNotContain("bob@example.test", kept);
        var everything = redactor.Begin(http, defaults with { ExcludeLabels = [] }, default);
        var all = await everything.RedactAsync(text);
        Assert.DoesNotContain("2026-11-09", all);
        Assert.DoesNotContain("https://example.test", all);
        Assert.Equal(text, everything.Restore(all));
        Assert.Equal(2, detector.Texts.Count);
        // Dates and URLs registered under the empty list stay literal where they are excluded.
        Assert.Equal(kept, await redactor.Begin(http, defaults, default).RedactAsync(text));
    }

    [Fact]
    public async Task Secret_markers_pass_through_detection_and_restoration_unchanged()
    {
        const string marker = "[[FW_SECRET:provider-key]]";
        const string indexed = "[[FW_SECRET:config.mcp.args[2]]]";
        var text = "Use key " + marker + " for Alice, then " + indexed + " ok.";
        // Detected ranges overlap the first marker on both sides and lie inside the second.
        await using var detector = await TextDetectionPeer.StartAsync(
            "key " + marker + " for",
            "Alice",
            "mcp.args",
            " " + indexed + " "
        );
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        var scope = new TextRedactor(Key).Begin(http, options, default);
        var result = await scope.RedactAsync(text);
        Assert.Contains(marker, result);
        Assert.Contains(indexed, result);
        Assert.DoesNotContain("Alice", result);
        Assert.DoesNotContain("key " + marker, result);
        Assert.DoesNotContain(marker + " for", result);
        Assert.Contains("then " + indexed + " ok.", result);
        Assert.Equal(text, scope.Restore(result));
        Assert.Equal(marker + " " + indexed, scope.Restore(marker + " " + indexed));
        Assert.Equal("prefix " + marker, scope.RestoreProgress("prefix " + marker));
        // Literal masking of known originals masks plain text but never enters markers.
        var masked = scope.MaskKnown(indexed + " Alice [[FW_SECRET:Alice]]");
        Assert.StartsWith(indexed + " " + TextRedactor.Prefix, masked);
        Assert.EndsWith(" [[FW_SECRET:Alice]]", masked);
        Assert.Equal(indexed + " Alice [[FW_SECRET:Alice]]", scope.Restore(masked));
    }
}
