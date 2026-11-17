using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Behavior of the background completion text: bounded output tail, partial/empty/unavailable,
// trailing-newline, binary and conversion cases. Editorial wording is not locked beyond the
// fields a reader relies on.
public sealed class ExecCompletionTests
{
    private static JsonObject Entry(string root, string? log = null) =>
        new()
        {
            ["id"] = "brave-fox",
            ["sessionId"] = "main/owned",
            ["nodeId"] = "master",
            ["command"] = "run something",
            ["logPath"] = log ?? Path.Combine(root, "output.log"),
            ["startedAt"] = 1_800_000_000_000L,
        };

    private static readonly JsonObject Finished = new()
    {
        ["exitCode"] = 3,
        ["finishedAt"] = "2027-01-15T08:00:02.000Z",
    };

    private static async Task<string> Complete(string root, byte[] output)
    {
        var entry = Entry(root);
        await File.WriteAllBytesAsync(entry["logPath"]!.GetValue<string>(), output);
        return await ExecOutput.Completion(entry, (JsonObject)Finished.DeepClone());
    }

    private static (string Head, string Body, string Footer) Split(string message)
    {
        var start = message.IndexOf("\nOutput", StringComparison.Ordinal);
        var body = message.IndexOf('\n', start + 1) + 1;
        var footer = message.LastIndexOf("\n---\n", StringComparison.Ordinal);
        return (message[..start], message[body..(footer + 1)], message[(footer + 5)..]);
    }

    [Fact]
    public async Task Complete_output_keeps_status_fields_exact_output_and_log_locator()
    {
        using var temp = new TempDirectory();
        var message = await Complete(temp.Path, "  first\n\tsecond  \n"u8.ToArray());
        Assert.StartsWith("Background Process Finished\nexecId: brave-fox\n", message);
        Assert.Contains("\nExit code: 3\n", message);
        Assert.Contains("\nDuration: 2s\n", message);
        Assert.Contains("\nOutput:\n", message);
        var (_, body, footer) = Split(message);
        Assert.Equal("  first\n\tsecond  \n", body);
        Assert.EndsWith("Command output in " + Path.Combine(temp.Path, "output.log"), footer);
        Assert.DoesNotContain("trailing newline", message);
        Assert.DoesNotContain("Output tail", message);
    }

    [Fact]
    public async Task Missing_trailing_newline_and_whitespace_only_output_are_preserved_and_stated()
    {
        using var temp = new TempDirectory();
        var message = await Complete(temp.Path, "done"u8.ToArray());
        var (_, body, footer) = Split(message);
        Assert.Equal("done\n", body);
        Assert.Contains("no trailing newline", footer);

        var blank = await Complete(temp.Path, "   \n\n"u8.ToArray());
        Assert.Equal("   \n\n", Split(blank).Body);
        Assert.DoesNotContain("(No output)", blank);
    }

    [Fact]
    public async Task Empty_output_gets_a_short_note_and_unavailable_output_is_not_called_empty()
    {
        using var temp = new TempDirectory();
        var empty = await Complete(temp.Path, []);
        Assert.Contains("\nOutput: (No output)\nCommand output in ", empty);
        Assert.DoesNotContain("---", empty);

        var missing = await ExecOutput.Completion(
            Entry(temp.Path, Path.Combine(temp.Path, "absent.log")),
            (JsonObject)Finished.DeepClone()
        );
        Assert.Contains("(Command output unavailable)", missing);
        Assert.DoesNotContain("(No output)", missing);
        Assert.Contains("Exit code: 3", missing);

        var failing = new ExecOutput.Files(
            _ => throw new IOException("target unreachable"),
            (_, _, _) => throw new IOException("target unreachable")
        );
        var provider = await ExecOutput.Completion(
            Entry(temp.Path, "provider://log"),
            (JsonObject)Finished.DeepClone(),
            failing
        );
        Assert.Contains("(Command output unavailable)", provider);
        Assert.Contains("Command output in provider://log", provider);
        Assert.DoesNotContain("target unreachable", provider);

        var cancelled = new ExecOutput.Files(
            _ => Task.FromResult(10L),
            (_, _, _) => throw new OperationCanceledException()
        );
        Assert.Contains(
            "(Command output unavailable)",
            await ExecOutput.Completion(
                Entry(temp.Path, "provider://log"),
                (JsonObject)Finished.DeepClone(),
                cancelled
            )
        );
    }

    [Fact]
    public async Task Long_output_shows_only_the_last_lines_and_states_shown_and_total_bytes()
    {
        using var temp = new TempDirectory();
        var text = string.Concat(Enumerable.Range(1, 100).Select(line => $"line {line}\n"));
        var message = await Complete(temp.Path, Encoding.UTF8.GetBytes(text));
        Assert.Contains("\nOutput tail:\n", message);
        var (_, body, footer) = Split(message);
        var lines = body.TrimEnd('\n').Split('\n');
        Assert.Equal(ExecOutput.CompletionTailLines, lines.Length);
        Assert.Equal("line 61", lines[0]);
        Assert.Equal("line 100", lines[^1]);
        Assert.Contains(Encoding.UTF8.GetByteCount(text).ToString(), footer);
        Assert.Contains(Encoding.UTF8.GetByteCount(body).ToString(), footer);
    }

    [Fact]
    public async Task Large_log_reads_one_bounded_window_and_drops_the_split_first_line()
    {
        using var temp = new TempDirectory();
        var line = new string('a', 300) + "\n";
        var text = string.Concat(Enumerable.Repeat(line, 4000)) + "last line\n";
        var reads = new List<(long Offset, int Count)>();
        var bytes = Encoding.UTF8.GetBytes(text);
        var files = new ExecOutput.Files(
            _ => Task.FromResult((long)bytes.Length),
            (_, offset, count) =>
            {
                reads.Add((offset, count));
                return Task.FromResult(bytes.AsSpan((int)offset, count).ToArray());
            }
        );
        var message = await ExecOutput.Completion(
            Entry(temp.Path, "provider://log"),
            (JsonObject)Finished.DeepClone(),
            files
        );
        var read = Assert.Single(reads);
        Assert.Equal(ExecOutput.CompletionTailBytes, read.Count);
        Assert.Equal(bytes.Length - ExecOutput.CompletionTailBytes, read.Offset);
        var body = Split(message).Body;
        Assert.EndsWith("last line\n", body);
        Assert.All(body.TrimEnd('\n').Split('\n')[..^1], shown => Assert.Equal(300, shown.Length));
        Assert.True(Encoding.UTF8.GetByteCount(body) <= ExecOutput.CompletionTailBytes);
    }

    [Fact]
    public async Task Long_line_split_UTF8_and_invalid_bytes_use_display_placeholders()
    {
        using var temp = new TempDirectory();
        var longLine = new string('x', 300) + new string('y', 300) + "\n";
        var message = await Complete(temp.Path, Encoding.UTF8.GetBytes(longLine));
        var body = Split(message).Body;
        Assert.Contains("[foxwarm: line too long (600 chars)]", body);
        Assert.StartsWith(new string('x', 250), body);
        Assert.EndsWith(new string('y', 250) + "\n", body);
        Assert.Contains("are not original output content", message);

        var invalid = await Complete(temp.Path, [.. "ok, mostly text "u8, 0xff, (byte)'\n']);
        Assert.Equal("ok, mostly text \\xff\n", Split(invalid).Body);
        Assert.Contains("display conversions", invalid);

        // A single line longer than the window starts inside a multibyte character.
        var wide = Encoding.UTF8.GetBytes(new string('é', 3000) + "\n");
        var cut = await Complete(temp.Path, wide);
        Assert.DoesNotContain("\\x", Split(cut).Body);
        Assert.Contains("Output tail:", cut);
    }

    [Fact]
    public async Task Binary_output_is_summarized_as_hex_without_raw_bytes()
    {
        using var temp = new TempDirectory();
        var bytes = Enumerable.Range(0, 3000).Select(index => (byte)(index % 7 == 0 ? 0 : index % 256)).ToArray();
        var message = await Complete(temp.Path, bytes);
        var body = Split(message).Body;
        Assert.Contains("appears binary", body);
        Assert.Contains(Convert.ToHexStringLower(bytes.AsSpan(bytes.Length - 64)), body);
        Assert.DoesNotContain('\0', message);
        Assert.Contains("3000", message);
    }

    [Fact]
    public async Task Node_error_and_command_preview_stay_in_the_header()
    {
        using var temp = new TempDirectory();
        var entry = Entry(temp.Path);
        entry["nodeId"] = "provider/target";
        entry["command"] = "echo `tick`  \n  " + new string('z', 200);
        await File.WriteAllTextAsync(entry["logPath"]!.GetValue<string>(), "out\n");
        var message = await ExecOutput.Completion(
            entry,
            new JsonObject { ["exitCode"] = null, ["error"] = "Execution lost: gone" }
        );
        var head = Split(message).Head;
        Assert.Contains("\nNode: `provider/target`", head);
        Assert.Contains("\nExit code: unknown", head);
        Assert.Contains("\nError: Execution lost: gone", head);
        Assert.Contains("command: `echo \\`tick\\` z", head);
        Assert.Contains("[foxwarm: command middle omitted]", head);
    }

    [Fact]
    public async Task CLI_completion_carries_the_same_output_tail()
    {
        using var temp = new TempDirectory();
        var previous = Environment.GetEnvironmentVariable("FOXWARM_AGENT_DIR");
        Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", temp.Path);
        try
        {
            var registry = Path.Combine(temp.Path, ".temp", "exec", "running-exec.json");
            Directory.CreateDirectory(Path.GetDirectoryName(registry)!);
            var record = Entry(temp.Path);
            record["pid"] = Environment.ProcessId;
            record["agentName"] = "main";
            record["nodeId"] = "cli-node";
            record["initialCwd"] = temp.Path;
            record["statusPath"] = Path.Combine(temp.Path, "output.exit.json");
            record["cwdPath"] = Path.Combine(temp.Path, "output.cwd.txt");
            record["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            record["notifyOnCompletion"] = true;
            record["completionCapability"] = "synthetic-grant";
            await File.WriteAllTextAsync(record["logPath"]!.GetValue<string>(), "built\nok");
            await File.WriteAllTextAsync(
                record["statusPath"]!.GetValue<string>(),
                "{\"exitCode\":0,\"finishedAt\":\"2026-10-20T00:00:00.000Z\"}"
            );
            await File.WriteAllTextAsync(
                registry,
                new JsonObject
                {
                    ["execs"] = new JsonArray(record),
                    ["recentExecIds"] = new JsonArray(),
                }.ToJsonString()
            );
            var messages = new List<string>();
            await using var manager = new NodeExecManager(
                new NodePaths(temp.Path),
                registry,
                (_, _, message) =>
                {
                    messages.Add(message);
                    return Task.CompletedTask;
                }
            );
            await manager.Initialize();
            var message = Assert.Single(messages);
            Assert.Contains("\nNode: `cli-node`", message);
            Assert.Equal("built\nok\n", Split(message).Body);
            Assert.Contains("no trailing newline", message);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_AGENT_DIR", previous);
        }
    }
}
