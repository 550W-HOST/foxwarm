using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class TextRedactionKnownLabelsTests
{
    private static async Task MissLater(HttpContext context, string text)
    {
        await context.Response.WriteAsJsonAsync(
            new JsonObject
            {
                ["entities"] = new JsonArray(),
                ["offset_unit"] = "utf8_bytes",
                ["input_bytes"] = Encoding.UTF8.GetByteCount(text),
                ["input_tokens"] = text.Length,
            }
        );
    }

    [Theory]
    [InlineData("private_email", true)]
    [InlineData("private_phone", true)]
    [InlineData("private_address", true)]
    [InlineData("private_person", false)]
    [InlineData("secret", false)]
    [InlineData("future_label", false)]
    public async Task Only_eligible_detection_spreads_to_new_slots_and_every_substitution_restores(
        string label,
        bool spreads
    )
    {
        const string original = "sample-value";
        await using var detector = await TextDetectionPeer.StartAsync(original);
        detector.Labels[original] = label;
        detector.Intercept = async (context, text) =>
        {
            if (!text.StartsWith("later"))
                return false;
            await MissLater(context, text);
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        using var redactor = new TextRedactor(TextRedactionTests.Key);
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var first = redactor.Begin(http, options, default);
        var masked = await first.RedactAsync(original);
        Assert.DoesNotContain(original, masked);
        Assert.Equal(original, first.Restore(masked));
        Assert.Equal(spreads ? 1 : 0, redactor.KnownCount);
        // New slot in this attempt, then a fresh attempt sharing the installation redactor.
        Assert.Equal(spreads, !(await first.RedactAsync("later " + original)).Contains(original));
        var next = redactor.Begin(http, options, default);
        var nextText = await next.RedactAsync("later again " + original);
        Assert.Equal(spreads, !nextText.Contains(original));
        Assert.Equal("later again " + original, next.Restore(nextText));
        // Memory-cache hits must restore all substitutions without enrolling disallowed labels.
        var cached = redactor.Begin(http, options, default);
        Assert.Equal(original, cached.Restore(await cached.RedactAsync(original)));
        Assert.Equal(spreads ? 1 : 0, redactor.KnownCount);
    }

    [Fact]
    public async Task Configured_requests_share_only_allowed_originals_across_sessions()
    {
        const string person = "Person Example";
        const string email = "person@example.test";
        await using var detector = await TextDetectionPeer.StartAsync(person, email);
        detector.Labels[person] = "private_person";
        detector.Labels[email] = "private_email";
        detector.Intercept = async (context, text) =>
        {
            if (!text.StartsWith("later"))
                return false;
            await MissLater(context, text);
            return true;
        };
        var sent = new List<string>();
        await using var provider = new ScriptedResponsesSequenceServer(
            3,
            async (_, connection, request) =>
            {
                var blocks = JsonNode.Parse(request.Body)!["messages"]![0]!["content"]!;
                var text = blocks is JsonValue value
                    ? value.GetValue<string>()
                    : string.Concat(blocks.AsArray().Select(block => (string?)block?["text"]));
                sent.Add(text);
                await LoopbackResponsesServer.WriteResponseAsync(
                    connection,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        new JsonObject
                        {
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "text", ["text"] = text }
                            ),
                            ["stop_reason"] = "end_turn",
                        }.ToJsonString()
                    )
                );
            }
        );
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        using var secrets = configuration.Secrets;
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = new JsonObject
                {
                    ["providers"] = new JsonObject
                    {
                        ["p"] = new JsonObject
                        {
                            ["providerType"] = "anthropic",
                            ["baseUrl"] = provider.BaseUri.ToString(),
                            ["extraFields"] = new JsonObject { ["stream"] = false },
                            ["models"] = new JsonArray("m"),
                            ["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint),
                        },
                    },
                }.ToJsonString(),
            }
        );
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        var owner = TestModelOwners.Create(
            http,
            new(provider.BaseUri, "m", "p/m", "", "", 100),
            new(),
            secrets: secrets
        );
        for (var index = 0; index < 3; index++)
        {
            var text = (index == 0 ? "detected " : "later " + index + " ") + person + " " + email;
            var result = await owner.RequestAsync(
                index < 2 ? "session-a" : "session-b",
                configuration.Capture(),
                "p/m",
                null,
                "cache",
                "turn",
                [
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                    },
                ],
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default
            );
            Assert.Equal(text, (string?)result.AssistantMessage!["parts"]![0]!["text"]);
            Assert.DoesNotContain(email, sent[index]);
            Assert.Equal(index > 0, sent[index].Contains(person));
        }
        Assert.Equal(1, secrets.TextRedactor().KnownCount);
    }

    [Fact]
    public async Task Mixed_labels_qualify_and_policy_changes_redetect_memory_and_disk_slots()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        var key = Enumerable.Range(0, 64).Select(index => (byte)index).ToArray();
        await using var detector = await TextDetectionPeer.StartAsync(
            "mixed-value",
            "person-value"
        );
        detector.Labels["mixed-value"] = "private_email";
        detector.Labels["person-value"] = "private_person";
        detector.Transform = response =>
        {
            var entities = response["entities"]!.AsArray();
            var email = entities.FirstOrDefault(entity =>
                (string?)entity?["label"] == "private_email"
            );
            if (email is not null)
            {
                var overlap = email.DeepClone();
                overlap["label"] = "private_person";
                entities.Add(overlap);
            }
            return response;
        };
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        const string text = "mixed-value person-value";
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        using (
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            )
        )
        {
            await redactor.Begin(http, options, default).RedactAsync(text);
            Assert.Equal(2, redactor.KnownCount);
            redactor.SetKnownLabels(TextRedactionKnownLabels.Default);
            Assert.Equal(1, redactor.KnownCount);
            var scope = redactor.Begin(http, options, default);
            Assert.Equal(text, scope.Restore(await scope.RedactAsync(text)));
            Assert.Equal(2, detector.Texts.Count);
            store.Flush();
            Assert.Single(store.ReadKnown());
        }
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        using (var redactor = new TextRedactor(TextRedactionTests.Key, store: store))
        {
            Assert.Equal(1, redactor.KnownCount);
            var scope = redactor.Begin(http, options, default);
            Assert.Equal(text, scope.Restore(await scope.RedactAsync(text)));
            Assert.Equal(2, detector.Texts.Count);
            Assert.Equal(1, redactor.KnownCount);
            Assert.DoesNotContain("mixed-value", scope.MaskKnown("new mixed-value"));
            Assert.Equal("new person-value", scope.MaskKnown("new person-value"));
            redactor.SetKnownLabels(TextRedactionKnownLabels.Parse(new JsonArray()));
            var none = redactor.Begin(http, options, default);
            Assert.Equal(text, none.Restore(await none.RedactAsync(text)));
            Assert.Equal(3, detector.Texts.Count);
            Assert.Equal(0, redactor.KnownCount);
            store.Flush();
            Assert.Empty(store.ReadKnown());
        }
    }

    [Fact]
    public void Load_purges_disallowed_rows_but_all_override_preserves_them()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, TextRedactionStore.FileName);
        var key = Enumerable.Range(0, 64).Select(index => (byte)index).ToArray();
        using var shape = new TextRedactor(TextRedactionTests.Key);
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        {
            foreach (
                var (original, labels) in new[]
                {
                    ("unlabelled", Array.Empty<string>()),
                    ("person", new[] { "private_person" }),
                    ("secret", new[] { "secret" }),
                    ("email", new[] { "private_email" }),
                    ("mixed", new[] { "private_person", "private_phone" }),
                }
            )
                store.PutKnown(
                    shape.Placeholder(Encoding.UTF8.GetBytes(original)),
                    original,
                    labels
                );
        }
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        using (
            var redactor = new TextRedactor(
                TextRedactionTests.Key,
                store: store,
                knownLabels: TextRedactionKnownLabels.All
            )
        )
            Assert.Equal(4, redactor.KnownCount);
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        using (var redactor = new TextRedactor(TextRedactionTests.Key, store: store))
        {
            Assert.Equal(2, redactor.KnownCount);
            store.Flush();
            Assert.Equal(
                new[] { "email", "mixed" },
                store.ReadKnown().Select(row => row.Original).Order()
            );
        }
        using (var store = TextRedactionStore.Open(path, key, 1 << 20)!)
        using (var redactor = new TextRedactor(TextRedactionTests.Key, store: store))
            Assert.Equal(2, redactor.KnownCount);
    }

    [Fact]
    public async Task Defaults_policy_applies_on_install_reload_and_restart_and_validates_all_scopes()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, environment: _ => null);
        var configuration = new ModelConfiguration(paths);
        using var secrets = configuration.Secrets;
        string Yaml(string labels) =>
            $$$"""
                defaults:
                  textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify', knownLabels: {{{labels}}}}
                providers:
                  p:
                    baseUrl: http://127.0.0.1:2
                    textRedaction: {threshold: 0.7}
                    models: [inherited, {id: tuned, textRedaction: {timeoutMs: 9000}}]
                """;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = Yaml("all") });
        var redactor = secrets.TextRedactor();
        Assert.True(
            redactor.TryRegister(redactor.Placeholder("person"u8), "person", ["private_person"])
        );
        Assert.Equal(1, redactor.KnownCount);
        var all = TextRedactionOptions.FromResolved(
            configuration.Capture().Resolve("p/tuned").Configuration["textRedaction"]!.AsObject()
        )!;
        Assert.Null(all.KnownLabels.Labels);
        await configuration.SaveAsync(
            new JsonObject { ["yaml"] = Yaml("[private_email, ' PRIVATE_PHONE ', private_email]") }
        );
        Assert.Equal(0, redactor.KnownCount);
        var options = TextRedactionOptions.FromResolved(
            configuration.Capture().Resolve("p/tuned").Configuration["textRedaction"]!.AsObject()
        )!;
        Assert.Equal(new[] { "private_email", "private_phone" }, options.KnownLabels.Labels);
        Assert.NotEqual(all, options);
        await configuration.SaveAsync(
            JsonNode.Parse("""{"providers":[{"id":"p","models":"inherited,tuned"}]}""")!.AsObject()
        );
        Assert.Equal(options.KnownLabels, configuration.Capture().KnownLabels);
        await File.WriteAllTextAsync(configuration.ActivePath, Yaml("all"));
        Assert.Null(configuration.Capture().KnownLabels.Labels);
        redactor.TryRegister(redactor.Placeholder("person"u8), "person", ["private_person"]);
        Assert.Equal(1, redactor.KnownCount);
        secrets.Dispose();
        var restarted = new ModelConfiguration(paths);
        using var reopened = restarted.Secrets;
        _ = restarted.Capture();
        Assert.Equal(1, reopened.TextRedactor().KnownCount);
        foreach (var value in new[] { "null", "true", "1", "'ALL'", "['']", "[' ']", "[1]", "{}" })
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                restarted.SaveAsync(new JsonObject { ["yaml"] = Yaml(value) })
            );
        foreach (
            var json in new[]
            {
                """{"providers":{"p":{"textRedaction":{"knownLabels":[]}}}}""",
                """{"providers":{"p":{"models":[{"id":"m","textRedaction":{"knownLabels":"all"}}]}}}""",
            }
        )
            Assert.Contains(
                "defaults.textRedaction",
                Assert
                    .Throws<InvalidDataException>(() =>
                        HostModels.Parse(JsonNode.Parse(json)!.AsObject(), new())
                    )
                    .Message
            );
        Assert.Equal(
            TextRedactionKnownLabels.Default,
            HostModels
                .Parse(JsonNode.Parse("""{"providers":{"p":{}}}""")!.AsObject(), new())
                .KnownLabels
        );
    }
}
