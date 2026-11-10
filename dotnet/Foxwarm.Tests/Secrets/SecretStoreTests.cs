using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;

namespace Foxwarm.Tests;

public sealed class SecretStoreTests
{
    private sealed class Clock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset now = now;

        public override DateTimeOffset GetUtcNow() => now;

        internal void Advance(TimeSpan by) => now += by;
    }

    private const string Value = "sk-synthetic-store-value-0123";

    [Fact]
    public void Key_is_owner_only_outside_state_and_values_are_encrypted_at_rest()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(temp.Path);
        secrets.Open();
        Assert.False(secrets.Locked);
        Assert.Equal(Path.Combine(temp.Path, "keys", "secrets.key"), secrets.KeyPath);
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite,
            File.GetUnixFileMode(secrets.KeyPath)
        );
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.GetDirectoryName(secrets.KeyPath)!)
        );

        var metadata = secrets.Store.Set("provider-key", Value, "Synthetic provider");
        Assert.True(metadata.IsSet);
        Assert.True(metadata.Redactable);
        var stored = File.ReadAllText(secrets.Store.FilePath, Encoding.UTF8);
        Assert.DoesNotContain(Value, stored);
        Assert.DoesNotContain(Convert.ToBase64String(Encoding.UTF8.GetBytes(Value)), stored);
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite,
            File.GetUnixFileMode(secrets.Store.FilePath)
        );

        // A second owner over the same data root reads the value with the same key file.
        var reopened = new InstanceSecrets(temp.Path);
        Assert.Equal(Value, reopened.Lookup("provider-key"));
        Assert.Null(reopened.Lookup("absent"));
    }

    [Fact]
    public void Missing_or_different_key_locks_the_store_without_replacing_the_key()
    {
        using var temp = new TempDirectory();
        var first = new InstanceSecrets(temp.Path);
        first.Store.Set("provider-key", Value);
        var original = File.ReadAllText(first.KeyPath);

        File.Delete(first.KeyPath);
        var missing = new InstanceSecrets(temp.Path);
        missing.Open();
        Assert.True(missing.Locked);
        Assert.False(File.Exists(first.KeyPath));
        Assert.Throws<SecretStoreLockedException>(() => missing.Lookup("provider-key"));
        // Metadata stays listable so Setup can show what is affected.
        Assert.Equal("provider-key", Assert.Single(missing.Store.List()).Name);

        var other = new TempDirectory();
        try
        {
            var foreign = new InstanceSecrets(other.Path);
            foreign.Open();
            File.Copy(foreign.KeyPath, first.KeyPath);
            var mismatched = new InstanceSecrets(temp.Path);
            Assert.Throws<SecretStoreLockedException>(() => mismatched.Lookup("provider-key"));
        }
        finally
        {
            other.Dispose();
        }

        File.WriteAllText(first.KeyPath, original);
        Assert.Equal(Value, new InstanceSecrets(temp.Path).Lookup("provider-key"));
    }

    [Fact]
    public void Replaced_and_deleted_values_stay_redactable_for_the_retention_period()
    {
        using var temp = new TempDirectory();
        var clock = new Clock(DateTimeOffset.Parse("2026-01-01T00:00:00Z"));
        var secrets = new InstanceSecrets(temp.Path, clock);
        secrets.Store.Set("provider-key", Value);
        secrets.Store.Set("provider-key", Value + "-next");
        Assert.Equal(Value + "-next", secrets.Lookup("provider-key"));
        Assert.Equal(
            new[] { Value, Value + "-next" }.Order(),
            secrets.Store.RedactionValues().Select(item => item.Value).Order()
        );
        Assert.Equal("[[FW_SECRET:provider-key]]", secrets.Redactor.Redact(Value));

        secrets.Store.Delete("provider-key");
        Assert.Null(secrets.Lookup("provider-key"));
        var listed = Assert.Single(secrets.Store.List());
        Assert.False(listed.IsSet);
        Assert.Equal(2, listed.RetiredVersions);
        Assert.Equal(2, secrets.Store.RedactionValues().Count);

        clock.Advance(SecretStore.RetiredRetention + TimeSpan.FromMinutes(1));
        var later = new InstanceSecrets(temp.Path, clock);
        Assert.Empty(later.Store.RedactionValues());
        Assert.Empty(later.Store.List());
        Assert.DoesNotContain("provider-key", File.ReadAllText(later.Store.FilePath));
    }

    [Fact]
    public void Short_values_are_accepted_but_not_redactable_and_names_are_validated()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(temp.Path);
        var metadata = secrets.Store.Set("pin", "short-pin");
        Assert.False(metadata.Redactable);
        Assert.Equal("short-pin", secrets.Lookup("pin"));
        Assert.Equal("short-pin", secrets.Redactor.Redact("short-pin"));
        // Short values are not known values either, so exec keeps such environment values.
        Assert.False(secrets.Redactor.IsKnownValue("short-pin"));
        Assert.Throws<InvalidDataException>(() => secrets.Store.Set("Upper", Value));
        Assert.Throws<InvalidDataException>(() => secrets.Store.Set("a b", Value));
        Assert.Throws<InvalidDataException>(() =>
            secrets.Store.Set("ok", "nul\0value-long-enough")
        );
        Assert.Throws<InvalidDataException>(() => secrets.Store.Set("ok", ""));
    }

    [Fact]
    public void Exposures_record_labels_sources_and_sessions_but_never_content()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(temp.Path);
        secrets.Store.Set("provider-key", Value);
        var masked = secrets.Redact("prefix " + Value + " suffix", "tool-output", "session-a");
        Assert.Equal("prefix [[FW_SECRET:provider-key]] suffix", masked);
        secrets.Exposures.Flush();
        var exposure = Assert.Single(secrets.Exposures.List());
        Assert.Equal(
            ("provider-key", "tool-output", "session-a"),
            (exposure.Label, exposure.LastSource, exposure.LastSessionId)
        );
        var persisted = File.ReadAllText(Path.Combine(temp.Path, "state", "secret-exposures.json"));
        Assert.DoesNotContain(Value, persisted);
        Assert.DoesNotContain("prefix", persisted);
        secrets.Exposures.Clear("provider-key");
        Assert.Empty(secrets.Exposures.List());
        secrets.Dispose();
    }

    [Fact]
    public void Owners_are_recorded_by_create_kept_by_replacement_and_handed_to_the_instance()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(temp.Path);
        var store = secrets.Store;

        // Setup values belong to the instance, also when written before ownership existed.
        store.Set("setup-key", Value);
        var legacy = JsonNode.Parse(File.ReadAllText(store.FilePath))!.AsObject();
        legacy["entries"]!["setup-key"]!.AsObject().Remove("owner");
        File.WriteAllText(store.FilePath, legacy.ToJsonString());
        var reopened = new InstanceSecrets(temp.Path).Store;
        Assert.Null(reopened.Owner("setup-key"));
        Assert.Null(reopened.List().Single().Owner);

        var created = reopened.Create("agent-key", Value + "-agent", "Synthetic", "worker");
        Assert.Equal("worker", created.Owner);
        Assert.Equal("worker", reopened.Owner("agent-key"));
        Assert.Null(reopened.Owner("absent"));
        // Create never replaces a current value; Setup replacement keeps the owner.
        Assert.Throws<InvalidOperationException>(() =>
            reopened.Create("agent-key", Value + "-other", null, "intruder")
        );
        Assert.Throws<InvalidOperationException>(() =>
            reopened.Create("setup-key", Value + "-other", null, "intruder")
        );
        reopened.Set("agent-key", Value + "-replaced");
        Assert.Equal("worker", reopened.Owner("agent-key"));
        Assert.Equal(Value + "-replaced", reopened.Resolve("agent-key"));

        // A name whose values were all deleted can be created again by its new owner.
        reopened.Delete("setup-key");
        Assert.Equal("other", reopened.Create("setup-key", Value + "-new", null, "other").Owner);

        Assert.Equal(["agent-key"], reopened.TransferToInstance("worker"));
        Assert.Null(reopened.Owner("agent-key"));
        Assert.Empty(reopened.TransferToInstance("worker"));
        Assert.Equal("other", new InstanceSecrets(temp.Path).Store.Owner("setup-key"));
        // An owner this version does not recognize grants nothing.
        var unknown = JsonNode.Parse(File.ReadAllText(store.FilePath))!.AsObject();
        unknown["entries"]!["setup-key"]!["owner"] = new JsonObject { ["kind"] = "team" };
        File.WriteAllText(store.FilePath, unknown.ToJsonString());
        Assert.Null(new InstanceSecrets(temp.Path).Store.Owner("setup-key"));
    }

    [Fact]
    public void Withdrawing_an_unused_value_keeps_earlier_retired_values()
    {
        using var temp = new TempDirectory();
        var store = new InstanceSecrets(temp.Path).Store;
        store.Create("fresh-key", Value + "-fresh", null, "asker");
        store.Withdraw("fresh-key");
        Assert.Empty(store.List());
        Assert.Empty(store.RedactionValues());

        // A reused name keeps masking its deleted value for the retention period.
        store.Set("reused-key", Value + "-old");
        store.Delete("reused-key");
        store.Create("reused-key", Value + "-new", null, "asker");
        store.Withdraw("reused-key");
        Assert.False(store.Contains("reused-key"));
        Assert.Equal(
            [Value + "-old"],
            store.RedactionValues().Select(item => item.Value).ToArray()
        );
        store.Withdraw("absent-key");
    }
}

public sealed class SecretReferenceTests
{
    [Fact]
    public void References_resolve_only_in_declared_sinks()
    {
        var models = JsonNode
            .Parse(
                """
                {"providers":{"p":{"apiKey":"${secret:provider-key}","baseUrl":"https://example.test/v1",
                  "extraHeaders":{"X-Api":"Token ${secret:header-key}"},"models":["m"]}}}
                """
            )!
            .AsObject();
        var missing = new List<string>();
        var resolved = SecretReferences.Resolve(
            models,
            SecretSinks.Models,
            "Models configuration",
            name => name == "provider-key" ? "resolved-provider-value" : null,
            missing
        );
        Assert.Equal(
            "resolved-provider-value",
            resolved["providers"]!["p"]!["apiKey"]!.GetValue<string>()
        );
        Assert.Equal(
            "Token ",
            resolved["providers"]!["p"]!["extraHeaders"]!["X-Api"]!.GetValue<string>()
        );
        Assert.Equal(["header-key"], missing);
        // The source document is not modified.
        Assert.Equal(
            "${secret:provider-key}",
            models["providers"]!["p"]!["apiKey"]!.GetValue<string>()
        );

        var misplaced = JsonNode.Parse(
            """{"providers":{"p":{"baseUrl":"${secret:provider-key}","models":["m"]}}}"""
        );
        var error = Assert.Throws<InvalidDataException>(() =>
            SecretReferences.Validate(misplaced, SecretSinks.Models, "Models configuration")
        );
        Assert.Contains("baseUrl", error.Message);
        Assert.Throws<InvalidDataException>(() =>
            SecretReferences.Validate(
                JsonNode.Parse("""{"providers":{"p":{"apiKey":"${secret:Bad Name}"}}}"""),
                SecretSinks.Models,
                "Models configuration"
            )
        );
        Assert.Equal(
            ["header-key", "provider-key"],
            SecretReferences.ReferencedNames(models).Order()
        );
    }

    [Fact]
    public void Literal_configuration_credentials_feed_the_redactor_with_config_labels()
    {
        var app = JsonNode
            .Parse(
                """
                {"channels":{"tg":{"type":"telegram","botToken":"123456:literal-telegram-token"},
                  "hook":{"type":"generic","webhookUrl":"https://hooks.example.test/path?token=literal-query-token-1"}},
                 "llm":{"openaiApiKey":"${secret:openai}"}}
                """
            )!
            .AsObject();
        var literals = InstanceSecrets
            .Literals(SecretSinks.App, app, path => "config." + path)
            .ToArray();
        Assert.Contains(
            literals,
            item =>
                item
                    is {
                        Label: "config.channels.tg.botToken",
                        Value: "123456:literal-telegram-token"
                    }
        );
        Assert.Contains(literals, item => item.Value.Contains("literal-query-token-1"));
        Assert.DoesNotContain(literals, item => item.Value.Contains("${secret:"));
        Assert.DoesNotContain(
            literals,
            item => item.Value == "https://hooks.example.test/path?token=literal-query-token-1"
        );
    }

    [Fact]
    public void Writer_guard_rejects_markers_of_known_values_only()
    {
        var redactor = new SecretRedactor([
            new KnownSecret("provider-key", "sk-synthetic-guard-value-01"),
        ]);
        Assert.Throws<InvalidDataException>(() =>
            SecretMarkerGuard.Require(
                new JsonObject { ["content"] = "key: [[FW_SECRET:provider-key]]" },
                redactor.HasLabel
            )
        );
        // Documentation and source that mention the marker format remain writable.
        SecretMarkerGuard.Require(
            new JsonObject
            {
                ["content"] = "Markers look like [[FW_SECRET:<name>]] or [[FW_SECRET:other]].",
            },
            redactor.HasLabel
        );
        SecretMarkerGuard.Require(
            new JsonObject { ["content"] = "key: ${secret:provider-key}" },
            redactor.HasLabel
        );
    }
}
