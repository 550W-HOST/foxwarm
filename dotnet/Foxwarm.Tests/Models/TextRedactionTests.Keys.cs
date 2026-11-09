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
        var first = await new TextRedactor(keys.Secrets.TextRedactionPlaceholderKey()).RedactAsync(
            http,
            options,
            value,
            default
        );
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
                await new TextRedactor(key).RedactAsync(http, options, value, default)
            );
            Assert.Same(
                TextRedactor.For(key),
                TextRedactor.For(restarted.TextRedactionPlaceholderKey())
            );
        }
        Assert.Equal(
            await new TextRedactor(Key).RedactAsync(http, options, value, default),
            await new TextRedactor(Key).RedactAsync(http, options, value, default)
        );
        using var otherInstance = new TextRedactionKeys();
        var other = await new TextRedactor(
            otherInstance.Secrets.TextRedactionPlaceholderKey()
        ).RedactAsync(http, options, value, default);
        Assert.NotEqual(first, other);
        Assert.NotEqual(
            await new TextRedactor(Key).RedactAsync(http, options, value, default),
            await new TextRedactor(OtherKey).RedactAsync(http, options, value, default)
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
        var redacted = await redactor.RedactAsync(http, options, "to " + first, default);
        var failure = await Assert.ThrowsAsync<TextRedactionException>(() =>
            redactor.RedactAsync(http, options, "to " + second, default)
        );
        Assert.False(failure.Retryable);
        Assert.Contains("collision", failure.Message);
        Assert.Equal("to " + first, redactor.Restore(redacted));
        // The failed text was not cached as a successful detection.
        await Assert.ThrowsAsync<TextRedactionException>(() =>
            redactor.RedactAsync(http, options, "to " + second, default)
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
                    textRedaction: {excludeLabels: [private_person, private_date, private_person]}
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
        detector.Labels["2026-11-09"] = "private_date";
        detector.Labels["https://example.test/x"] = "private_url";
        detector.Labels["bob@example.test"] = "private_email";
        using var http = ProviderHttpRequest.CreateClient();
        var redactor = new TextRedactor(Key);
        var defaults = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        var kept = await redactor.RedactAsync(http, defaults, text, default);
        Assert.Contains("2026-11-09", kept);
        Assert.Contains("https://example.test/x", kept);
        Assert.DoesNotContain("bob@example.test", kept);
        var all = await redactor.RedactAsync(
            http,
            defaults with
            {
                ExcludeLabels = [],
            },
            text,
            default
        );
        Assert.DoesNotContain("2026-11-09", all);
        Assert.DoesNotContain("https://example.test", all);
        Assert.Equal(text, redactor.Restore(all));
        Assert.Equal(2, detector.Texts.Count);
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
        var redactor = new TextRedactor(Key);
        var options = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        var result = await redactor.RedactAsync(http, options, text, default);
        Assert.Contains(marker, result);
        Assert.Contains(indexed, result);
        Assert.DoesNotContain("Alice", result);
        Assert.DoesNotContain("key " + marker, result);
        Assert.DoesNotContain(marker + " for", result);
        Assert.Contains("then " + indexed + " ok.", result);
        Assert.Equal(text, redactor.Restore(result));
        Assert.Equal(marker + " " + indexed, redactor.Restore(marker + " " + indexed));
        Assert.Equal("prefix " + marker, redactor.RestoreProgress("prefix " + marker));
    }
}
