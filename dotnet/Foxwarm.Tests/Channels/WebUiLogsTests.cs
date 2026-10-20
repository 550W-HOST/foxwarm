using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;

namespace Foxwarm.Tests;

public sealed class WebUiLogsTests
{
    [Fact]
    public async Task Original_reader_matches_byte_windows_time_lookup_and_sparse_bounds()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        var start = DateTimeOffset.Parse("2026-01-02T00:00:00Z").ToUnixTimeMilliseconds();
        var text =
            string.Concat(Enumerable.Repeat("[01:02:03.004] INFO: old unknown\n", 7000))
            + string.Concat(
                Enumerable
                    .Range(0, 18000)
                    .Select(index =>
                        $"[{DateTimeOffset.FromUnixTimeMilliseconds(start + (index % 101 == 0 ? Math.Max(0, index - 2) : index) * 1000):yyyy-MM-dd HH:mm:ss.fff} +0000] INFO: synthetic {index} 汉字 🦊\r\n"
                    )
            )
            + "unfinished tail";
        await File.WriteAllTextAsync(path, text);
        var operations = JsonNode
            .Parse(
                """[{"direction":"latest"},{"direction":"before","offset":"start"},{"direction":"after","offset":"end"}]"""
            )!
            .AsArray();
        operations.Add(new JsonObject { ["time"] = start + 8000 * 1000 });
        operations.Add(new JsonObject { ["time"] = start - 86400000 });
        await Compare(path, operations);
        var character = Encoding.UTF8.GetBytes("🦊");
        await File.WriteAllBytesAsync(
            path,
            Encoding.UTF8.GetBytes("tail ").Concat(character.Take(2)).ToArray()
        );
        await Compare(
            path,
            JsonNode
                .Parse("""[{"direction":"latest"},{"direction":"after","offset":"end"}]""")!
                .AsArray()
        );
        await File.WriteAllTextAsync(
            path,
            "\u001b[32m[2026-01-02 00:00:00.000 +0000] INFO: first\u001b[0m\n{\"time\":"
                + (start + 1000)
                + ",\"msg\":\"JSON\"}\n"
        );
        await Compare(
            path,
            new JsonArray(
                new JsonObject { ["direction"] = "latest" },
                new JsonObject { ["time"] = start + 1000 }
            )
        );
        await using (var sparse = File.OpenWrite(path))
            sparse.SetLength(384 * 1024 * 1024);
        await File.AppendAllTextAsync(path, "sparse tail\n");
        await Compare(
            path,
            JsonNode
                .Parse("""[{"direction":"latest"},{"direction":"before","offset":"start"}]""")!
                .AsArray()
        );
    }

    private static async Task Compare(string path, JsonArray operations)
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "Set FOXWARM_TS_ROOT for the original reader oracle."
            );
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(Path.Combine(root, "dotnet", "webui-logs-fixture-ts.mjs"));
        using var child = Process.Start(info)!;
        await child.StandardInput.WriteAsync(
            new JsonObject
            {
                ["path"] = path,
                ["operations"] = operations.DeepClone(),
            }.ToJsonString()
        );
        child.StandardInput.Close();
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(child.ExitCode == 0, await errors);
        var expected = JsonNode.Parse(await output)!.AsArray();
        using var logs = new WebUiLogFile(path);
        LogWindow? cursor = null;
        for (var index = 0; index < operations.Count; index++)
        {
            var operation = operations[index]!;
            JsonObject result;
            try
            {
                if (operation["time"] is not null)
                    result = await logs.Seek(
                        double.Parse(
                            operation["time"]!.ToString(),
                            System.Globalization.CultureInfo.InvariantCulture
                        ),
                        cursor!.FileId!
                    );
                else
                {
                    var direction = operation["direction"]!.GetValue<string>();
                    var position = operation["offset"]?.ToString();
                    cursor = await logs.Read(
                        direction,
                        position == "start" ? cursor!.StartOffset
                            : position == "end" ? cursor!.EndOffset
                            : null,
                        direction == "latest" ? null : cursor?.FileId
                    );
                    result = new() { ["window"] = cursor.Json() };
                }
                result["window"]!["fileId"] = result["window"]!["fileId"] is null ? null : "file";
            }
            catch (Exception error) when (error is IOException or InvalidDataException)
            {
                result = new() { ["error"] = error.Message };
            }
            Assert.True(
                JsonNode.DeepEquals(expected[index], result),
                $"Operation {index}: expected {expected[index]}, actual {result}"
            );
        }
    }

    [Fact]
    public async Task Missing_empty_continuous_paging_incomplete_eof_and_observed_lifetimes()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        using var logs = new WebUiLogFile(path);
        Assert.True((await logs.Read()).Missing);
        await File.WriteAllTextAsync(path, "");
        var empty = await logs.Read();
        Assert.False(empty.Missing);
        Assert.Equal(0, empty.LineCount);
        var text =
            string.Concat(Enumerable.Repeat("synthetic 汉字 🦊 record\r\n", 24000))
            + "unfinished tail";
        await File.WriteAllTextAsync(path, text);
        var pages = new List<string>();
        var current = await logs.Read();
        while (true)
        {
            Assert.InRange(current.EndOffset - current.StartOffset, 0, WebUiLogFile.WindowBytes);
            Assert.DoesNotContain("\ufffd", current.Text);
            pages.Insert(0, current.Text);
            if (current.StartOffset == 0)
                break;
            var older = await logs.Read("before", current.StartOffset, current.FileId);
            Assert.Equal(current.StartOffset, older.EndOffset);
            var newer = await logs.Read("after", older.EndOffset, older.FileId);
            Assert.Equal(current.StartOffset, newer.StartOffset);
            current = older;
        }
        Assert.Equal(text, string.Concat(pages));
        await File.WriteAllBytesAsync(
            path,
            Encoding.UTF8.GetBytes("tail ").Concat(Encoding.UTF8.GetBytes("🦊").Take(2)).ToArray()
        );
        await Assert.ThrowsAsync<LogFileResetException>(() =>
            logs.Read("after", current.EndOffset, current.FileId)
        );
        var partial = await logs.Read();
        Assert.Equal("tail ", partial.Text);
        Assert.Equal(2, partial.PendingBytes);
        await using (var append = new FileStream(path, FileMode.Append))
            await append.WriteAsync(
                Encoding.UTF8.GetBytes("🦊").Skip(2).Concat(new byte[] { 10 }).ToArray()
            );
        var completed = await logs.Read("after", partial.EndOffset, partial.FileId);
        Assert.Equal("tail 🦊\n", partial.Text + completed.Text);
        File.Move(path, path + ".previous");
        await File.WriteAllTextAsync(path, "replacement\n");
        await Assert.ThrowsAsync<LogFileResetException>(() => logs.Read(fileId: completed.FileId));
        var replacement = await logs.Read();
        File.Delete(path);
        await Assert.ThrowsAsync<LogFileResetException>(() =>
            logs.Read(fileId: replacement.FileId)
        );
    }

    [Fact]
    public async Task File_tail_isolates_slow_clients_gaps_resets_errors_and_disposal()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        await File.WriteAllTextAsync(path, "initial\n");
        using var logs = new WebUiLogFile(path, 10);
        var slow = false;
        var frames = new ConcurrentQueue<JsonObject>();
        var healthy = new ConcurrentQueue<JsonObject>();
        var stop = logs.Subscribe(new("slow"), frames.Enqueue, () => !Volatile.Read(ref slow));
        var stopHealthy = logs.Subscribe(new("healthy"), healthy.Enqueue, () => true);
        await Until(() =>
            frames.Any(f => f["type"]!.ToString() == "logs-snapshot")
            && healthy.Any(f => f["type"]!.ToString() == "logs-snapshot")
        );
        slow = true;
        await File.AppendAllTextAsync(path, "not queued for slow\n");
        await Until(() => healthy.Any(f => f["type"]!.ToString() == "logs-delta"));
        Assert.DoesNotContain(frames, f => f["type"]!.ToString() == "logs-delta");
        slow = false;
        await Until(() => frames.Any(f => f["type"]!.ToString() == "logs-gap"));
        Assert.Single(frames, f => f["type"]!.ToString() == "logs-gap");
        stop();
        stopHealthy();
        Assert.Equal(0, logs.SubscriberCount);
        var cursor = await logs.Read();
        await File.AppendAllTextAsync(path, new string('x', WebUiLogFile.CatchupBytes + 1));
        var gap = new ConcurrentQueue<JsonObject>();
        logs.Subscribe(
            new("catchup", new(cursor.FileId!, cursor.EndOffset)),
            gap.Enqueue,
            () => true
        );
        await Until(() => gap.Any());
        Assert.Equal("logs-gap", gap.Single()["type"]!.ToString());
        var reset = new ConcurrentQueue<JsonObject>();
        logs.Subscribe(new("reset"), reset.Enqueue, () => true);
        await Until(() => reset.Any());
        File.Move(path, path + ".old");
        await File.WriteAllTextAsync(path, "replacement");
        await Until(() => reset.Any(f => f["type"]!.ToString() == "logs-reset"));
        File.Delete(path);
        Directory.CreateDirectory(path);
        var errors = new ConcurrentQueue<JsonObject>();
        logs.Subscribe(new("error"), errors.Enqueue, () => true);
        await Until(() => errors.Any());
        Assert.Equal("logs-error", errors.Single()["type"]!.ToString());
        Directory.Delete(path);
        await File.WriteAllTextAsync(path, "recovered by caller");
        logs.Dispose();
        var count = reset.Count;
        await File.AppendAllTextAsync(path, "after disposal");
        Assert.Equal(count, reset.Count);
        Assert.Equal(0, logs.SubscriberCount);
    }

    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition())
            await Task.Delay(10, timeout.Token);
    }
}
