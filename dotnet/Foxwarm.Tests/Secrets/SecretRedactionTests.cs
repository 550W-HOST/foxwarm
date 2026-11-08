using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;

namespace Foxwarm.Tests;

public sealed class SecretRedactionTests
{
    private const string Value = "sk-synthetic/redact+value=0123";

    private static SecretRedactor Redactor(params (string Label, string Value)[] values) =>
        new(values.Select(item => new KnownSecret(item.Label, item.Value)));

    [Fact]
    public void Common_encodings_are_masked_with_the_secret_name()
    {
        var redactor = Redactor(("provider-key", Value));
        var bytes = Encoding.UTF8.GetBytes(Value);
        var forms = new[]
        {
            Value,
            Uri.EscapeDataString(Value),
            Uri.EscapeDataString(Value).ToLowerInvariant(),
            Convert.ToHexString(bytes),
            Convert.ToHexStringLower(bytes),
            Convert.ToBase64String(bytes),
            Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'),
            Convert.ToBase64String(Encoding.UTF8.GetBytes("user:" + Value)),
            new JsonObject { ["v"] = Value }.ToJsonString(),
        };
        foreach (var form in forms)
        {
            var hits = new List<string>();
            var masked = redactor.Redact("before " + form + " after", hits);
            Assert.Contains("[[FW_SECRET:provider-key]]", masked);
            Assert.DoesNotContain(Value, masked);
            Assert.Equal(["provider-key"], hits.Distinct());
        }
        Assert.Equal("unrelated text", redactor.Redact("unrelated text"));
    }

    [Fact]
    public void Longest_match_wins_and_json_nodes_are_copy_on_write()
    {
        var redactor = Redactor(("short", "abcdefghijkl"), ("long", "abcdefghijklmnop"));
        Assert.Equal("x [[FW_SECRET:long]] y", redactor.Redact("x abcdefghijklmnop y"));
        var clean = new JsonObject { ["a"] = "nothing here" };
        Assert.Same(clean, redactor.Redact(clean));
        var dirty = new JsonObject { ["a"] = new JsonArray("abcdefghijkl") };
        var masked = redactor.Redact(dirty)!;
        Assert.NotSame(dirty, masked);
        Assert.Equal("[[FW_SECRET:short]]", masked["a"]![0]!.GetValue<string>());
        Assert.Equal("abcdefghijkl", dirty["a"]![0]!.GetValue<string>());
    }

    [Fact]
    public void Reasoning_parts_are_reported_and_left_byte_identical()
    {
        var redactor = Redactor(("provider-key", Value));
        var message = new JsonObject
        {
            ["role"] = "model",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["thinking"] = "I saw " + Value,
                    ["providerMeta"] = new JsonObject { ["signature"] = "sig" },
                },
                new JsonObject
                {
                    ["text"] = "summary",
                    ["providerMeta"] = new JsonObject
                    {
                        ["encryptedThinking"] = "opaque",
                        ["thinkingSummaries"] = new JsonArray(Value),
                    },
                },
                new JsonObject { ["text"] = "visible " + Value },
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["name"] = "exec",
                        ["args"] = new JsonObject { ["command"] = "echo " + Value },
                    },
                }
            ),
        };
        var original = message.ToJsonString();
        var findings = new SecretMessageRedaction.Findings();
        var masked = SecretMessageRedaction.Message(redactor, message, findings);
        Assert.Equal(original, message.ToJsonString());
        var parts = masked["parts"]!.AsArray();
        Assert.Equal(message["parts"]![0]!.ToJsonString(), parts[0]!.ToJsonString());
        Assert.Equal(message["parts"]![1]!.ToJsonString(), parts[1]!.ToJsonString());
        Assert.Equal("visible [[FW_SECRET:provider-key]]", parts[2]!["text"]!.GetValue<string>());
        Assert.Equal(
            "echo [[FW_SECRET:provider-key]]",
            parts[3]!["functionCall"]!["args"]!["command"]!.GetValue<string>()
        );
        Assert.Contains("provider-key", findings.Masked);
        Assert.Equal(["provider-key"], findings.Reasoning);
    }

    [Fact]
    public void Request_stage_masks_instructions_tools_and_history_copies()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(temp.Path);
        secrets.Store.Set("provider-key", Value);
        var stored = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "key " + Value }),
        };
        var clean = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "clean" }),
        };
        var history = new RequestHistory([
            new RequestHistory.Row(clean),
            new RequestHistory.Row(stored),
        ]);
        var result = SecretRequestStage.Apply(
            secrets,
            "memory " + Value,
            new JsonArray(new JsonObject { ["description"] = Value }),
            history,
            "session-a"
        );
        Assert.Equal("memory [[FW_SECRET:provider-key]]", result.Instructions);
        Assert.DoesNotContain(Value, result.Tools!.ToJsonString());
        Assert.Same(clean, result.History.Rows[0].Message);
        Assert.DoesNotContain(Value, result.History.Rows[1].Message.ToJsonString());
        Assert.Equal("key " + Value, stored["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Contains(secrets.Exposures.List(), item => item.LastSource == "model-request");
        secrets.Dispose();
    }
}
