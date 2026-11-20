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

    // Source refreshes are then driven only by invalidation, not by elapsed time.
    private sealed class StoppedClock : TimeProvider
    {
        public override long GetTimestamp() => 0;
    }

    [Fact]
    public void A_reader_during_a_rebuild_waits_for_the_rebuilt_matcher()
    {
        const string before = "synthetic-source-value-before-0001";
        const string after = "synthetic-source-value-after-0002";
        using var temp = new TempDirectory();
        using var secrets = new InstanceSecrets(temp.Path, new StoppedClock());
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var current = before;
        var holdNext = 0;
        secrets.AddSource(
            "source",
            () =>
            {
                var value = Volatile.Read(ref current);
                if (Interlocked.Exchange(ref holdNext, 0) == 1)
                {
                    entered.Set();
                    release.Wait();
                }
                return [new KnownSecret("source", value)];
            }
        );
        Assert.Equal("got [[FW_SECRET:source]]", secrets.Redact("got " + before, "test"));

        // A configuration change publishes the new value and invalidates. Hold the rebuild
        // that reads it while another caller asks for the matcher: that caller must wait for
        // the rebuild rather than mask with the previous matcher.
        Volatile.Write(ref current, after);
        Volatile.Write(ref holdNext, 1);
        secrets.Invalidate();
        var rebuild = Task.Run(() => secrets.Redactor);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(30)), "the rebuild did not read the source");
        string? observed = null;
        var reader = new Thread(() => observed = secrets.Redact("got " + after, "test"));
        reader.Start();
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);
        while (
            reader.IsAlive && (reader.ThreadState & System.Threading.ThreadState.WaitSleepJoin) == 0
        )
        {
            Assert.True(DateTime.UtcNow < deadline, "the reader neither finished nor waited");
            Thread.Yield();
        }
        var finishedDuringRebuild = !reader.IsAlive;
        release.Set();
        rebuild.Wait();
        reader.Join();
        Assert.False(finishedDuringRebuild, "the reader used the matcher from before the change");
        Assert.Equal("got [[FW_SECRET:source]]", observed);
    }
}
