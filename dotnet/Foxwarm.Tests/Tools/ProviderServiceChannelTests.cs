using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Code;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed class ProviderServiceChannelTests
{
    internal static string Script =>
        Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "node-provider-services.py");

    internal static JsonObject Configuration(
        string root,
        string mode = "normal",
        int timeout = 5
    ) =>
        new()
        {
            ["type"] = "executable",
            ["command"] = "python3",
            ["args"] = new JsonArray(Script, root, mode),
            ["timeoutSeconds"] = (double)timeout,
        };

    internal sealed class Rig : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal readonly NodeConnectionHub Native;
        internal readonly NodeProviderRegistry Registry;
        internal readonly ConcurrentQueue<(Guid Generation, string Reason)> Disconnects = new();

        internal Rig(string mode = "normal", int timeout = 5)
        {
            Native = new NodeConnectionHub(Path.Combine(Temp.Path, "main"));
            Registry = new NodeProviderRegistry(
                Native,
                new JsonObject { ["fixture"] = Configuration(Root, mode, timeout) }
            );
            Registry.ServicesDisconnected += (generation, reason) =>
                Disconnects.Enqueue((generation, reason));
        }

        internal string Root => Path.Combine(Temp.Path, "target");
        internal string Work => Path.Combine(Root, "work");

        internal JsonObject[] Log() =>
            File.Exists(Path.Combine(Root, "channel.jsonl"))
                ? File.ReadAllLines(Path.Combine(Root, "channel.jsonl"))
                    .Select(line => JsonNode.Parse(line)!.AsObject())
                    .ToArray()
                : [];

        internal int Count(string key, string? value = null) =>
            Log()
                .Count(entry =>
                    entry.ContainsKey(key) && (value is null || entry[key]!.ToString() == value)
                );

        internal async Task<Guid> FirstDisconnectAsync()
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (Disconnects.TryPeek(out var item))
                    return item.Generation;
                await Task.Delay(50);
            }
            throw new TimeoutException("No service disconnect was published.");
        }

        internal Task<JsonObject> Fs(string node, string operation, JsonObject args) =>
            Registry.RequestServiceAsync(
                "fixture/" + node,
                "vscode-fs",
                operation,
                args,
                CancellationToken.None
            );

        public async ValueTask DisposeAsync()
        {
            await Registry.DisposeAsync();
            Native.Dispose();
            Temp.Dispose();
        }
    }

    private static async Task<T> Eventually<T>(Func<T?> probe)
        where T : class
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (probe() is { } value)
                return value;
            await Task.Delay(50);
        }
        throw new TimeoutException("Condition was not reached.");
    }

    [Fact]
    public async Task Declared_services_are_published_for_ready_nodes_and_unknown_names_are_ignored()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var nodes = await rig.Registry.ListAsync(default);
        JsonObject Services(string id) =>
            nodes.OfType<JsonObject>().Single(node => node["id"]!.ToString() == "fixture/" + id)[
                "services"
            ]!.AsObject();
        Assert.Equal(3, Services("svc").Count);
        Assert.Equal(1, Services("fsonly")["vscode-fs"]!.GetValue<int>());
        Assert.Empty(Services("plain"));
        Assert.Empty(Services("down"));
        Assert.Equal(
            new[] { "fixture/fsonly", "fixture/svc", "fixture/svc2" },
            rig.Registry.ServiceNodes("vscode-fs")
        );
        Assert.Equal(
            new[] { "fixture/svc", "fixture/svc2" },
            rig.Registry.ServiceNodes("vscode-pty")
        );
        await using var future = new Rig("list-unknown-service");
        var listed = await future.Registry.ListAsync(default);
        var declared = listed
            .OfType<JsonObject>()
            .Single(node => node["id"]!.ToString() == "fixture/svc")["services"]!.AsObject();
        Assert.False(declared.ContainsKey("future-service"));
        Assert.Equal(3, declared.Count);
        await using var invalid = new Rig("list-bad-services");
        var error = await Assert.ThrowsAsync<NodeProviderException>(() =>
            invalid.Registry.ListAsync(default)
        );
        Assert.Equal("NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE", error.Code);
    }

    [Fact]
    public async Task Legacy_providers_without_services_publish_none_and_reject_service_use()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig("list-no-services");
        var nodes = await rig.Registry.ListAsync(default);
        Assert.All(nodes.OfType<JsonObject>(), node => Assert.Empty(node["services"]!.AsObject()));
        Assert.Empty(rig.Registry.ServiceNodes("vscode-fs"));
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal("UnsupportedService", error.Code);
        Assert.Equal(501, error.Status);
        Assert.Equal(0, rig.Count("connect"));
    }

    [Fact]
    public async Task Channel_starts_lazily_once_and_serves_concurrent_requests_without_rediscovery()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        Assert.Equal(0, rig.Count("connect"));
        // Cold concurrent callers share one discovery and one channel; one-shot admission is eight.
        var cold = await Task.WhenAll(
            Enumerable
                .Range(0, 24)
                .Select(_ => rig.Fs("svc", "stat", new() { ["path"] = rig.Work }))
        );
        Assert.All(cold, value => Assert.Equal(2, value["type"]!.GetValue<int>()));
        Assert.Equal(1, rig.Count("connect"));
        Assert.Equal(1, rig.Count("oneShot", "list"));
        await Task.WhenAll(
            Enumerable
                .Range(0, 64)
                .Select(_ => rig.Fs("svc", "read-directory", new() { ["path"] = rig.Work }))
        );
        Assert.Equal(1, rig.Count("connect"));
        Assert.Equal(1, rig.Count("oneShot", "list"));
        Assert.Equal(24 + 64, rig.Count("frame", "node_service_request"));
        // Another Node is another channel; the first remains untouched.
        await rig.Fs("svc2", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(2, rig.Count("connect"));
        Assert.Equal(
            new[] { "svc", "svc2" },
            rig.Log()
                .Where(e => e.ContainsKey("connect"))
                .Select(e => e["connect"]!.ToString())
                .Order()
        );
    }

    [Fact]
    public async Task Filesystem_operations_round_trip_with_service_error_codes_and_statuses()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var file = Path.Combine(rig.Work, "notes.txt");
        var missing = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "read-file", new() { ["path"] = file })
        );
        Assert.Equal(("FileNotFound", 404), (missing.Code, missing.Status));
        await rig.Fs(
            "svc",
            "write-file",
            new()
            {
                ["path"] = file,
                ["contentBase64"] = Convert.ToBase64String("hello 雪"u8),
                ["create"] = true,
                ["overwrite"] = false,
            }
        );
        var exists = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs(
                "svc",
                "write-file",
                new()
                {
                    ["path"] = file,
                    ["contentBase64"] = "",
                    ["create"] = true,
                    ["overwrite"] = false,
                }
            )
        );
        Assert.Equal(409, exists.Status);
        Assert.Equal("hello 雪", File.ReadAllText(file));
        var read = await rig.Fs("svc", "read-file", new() { ["path"] = file });
        Assert.Equal(
            "hello 雪",
            System.Text.Encoding.UTF8.GetString(
                Convert.FromBase64String(read["contentBase64"]!.ToString())
            )
        );
        await rig.Fs(
            "svc",
            "rename",
            new()
            {
                ["path"] = file,
                ["newPath"] = file + ".moved",
                ["overwrite"] = false,
            }
        );
        var listing = await rig.Fs("svc", "read-directory", new() { ["path"] = rig.Work });
        Assert.Equal("notes.txt.moved", listing["entries"]![0]!["name"]!.ToString());
        await rig.Fs("svc", "delete", new() { ["path"] = file + ".moved", ["recursive"] = false });
        Assert.False(File.Exists(file + ".moved"));
        var relative = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = "relative" })
        );
        Assert.Equal("InvalidPath", relative.Code);
        Assert.Equal(1, rig.Count("connect"));
    }

    [Fact]
    public async Task Missing_unavailable_and_unsupported_services_fail_before_any_channel_starts()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var plain = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("plain", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal(("UnsupportedService", 501), (plain.Code, plain.Status));
        var down = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("down", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal(("NodeUnavailable", 503), (down.Code, down.Status));
        var absent = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("absent", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal("NodeUnavailable", absent.Code);
        var other = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Registry.RequestServiceAsync(
                "nowhere/node",
                "vscode-fs",
                "stat",
                new() { ["path"] = rig.Work },
                default
            )
        );
        Assert.Equal("NodeUnavailable", other.Code);
        var fsOnly = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Registry.ServiceAsync("fixture/fsonly", "vscode-pty", 1, default)
        );
        Assert.Equal("UnsupportedService", fsOnly.Code);
        var tooNew = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Registry.ServiceAsync("fixture/svc", "vscode-git", 2, default)
        );
        Assert.Equal("UnsupportedService", tooNew.Code);
        Assert.Equal(0, rig.Count("connect"));
    }

    [Fact]
    public async Task Provider_exit_ends_the_generation_fails_pending_calls_and_next_use_starts_a_new_one()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var first = await rig.Registry.ServiceAsync("fixture/svc", "vscode-fs", 1, default);
        var started = rig.Registry.RequestServiceAsync(
            first,
            "stat",
            new() { ["path"] = rig.Work },
            default
        );
        await started;
        var crash = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Registry.RequestServiceAsync(first, "crash", new(), default)
        );
        Assert.Equal(("NodeUnavailable", 503), (crash.Code, crash.Status));
        Assert.Contains("not retried", crash.Message);
        Assert.Equal(first.ConnectionId, await rig.FirstDisconnectAsync());
        // The old target is never silently moved to a replacement generation.
        var stale = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Registry.RequestServiceAsync(first, "stat", new() { ["path"] = rig.Work }, default)
        );
        Assert.Equal("NodeUnavailable", stale.Code);
        Assert.Equal(1, rig.Count("frame", "node_service_request") - 1); // stat before the crash only.
        var second = await rig.Registry.ServiceAsync("fixture/svc", "vscode-fs", 1, default);
        Assert.NotEqual(first.ConnectionId, second.ConnectionId);
        await rig.Registry.RequestServiceAsync(
            second,
            "stat",
            new() { ["path"] = rig.Work },
            default
        );
        Assert.Equal(2, rig.Count("connect"));
        // The crashed request was not replayed on the new generation.
        Assert.Equal(1, rig.Log().Count(e => e["operation"]?.ToString() == "crash"));
    }

    [Theory]
    [InlineData("connect-identity", "NODE_PROVIDER_REQUEST_MISMATCH")]
    [InlineData("connect-wrong-node", "NODE_PROVIDER_NODE_MISMATCH")]
    [InlineData("connect-error", "Target environment is not reachable.")]
    [InlineData("connect-exit", "could not be started")]
    public async Task Handshake_failures_are_unavailable_safe_and_not_retried(
        string mode,
        string expected
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig(mode);
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal(("NodeUnavailable", 503), (error.Code, error.Status));
        Assert.Contains(expected, error.Message);
        Assert.DoesNotContain(rig.Temp.Path, error.Message);
        Assert.Equal(1, rig.Count("connect"));
        Assert.Equal(0, rig.Count("frame"));
    }

    [Fact]
    public async Task Handshake_that_never_answers_is_bounded_by_the_provider_deadline()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig("connect-hang", timeout: 1);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal("NodeUnavailable", error.Code);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(8), clock.Elapsed.ToString());
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("oversize")]
    public async Task Invalid_or_oversized_provider_frames_end_the_generation(string operation)
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var target = await rig.Registry.ServiceAsync("fixture/svc", "vscode-fs", 1, default);
        var pending = rig.Registry.RequestServiceAsync(target, operation, new(), default);
        var error = await Assert.ThrowsAsync<CodeServiceException>(() => pending);
        Assert.Equal("NodeUnavailable", error.Code);
        await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(2, rig.Count("connect"));
    }

    [Fact]
    public async Task Fifty_MiB_file_round_trips_inside_the_frame_limit_in_both_directions()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var bytes = RandomNumberGenerator.GetBytes(50 * 1024 * 1024);
        var file = Path.Combine(rig.Work, "large.bin");
        var encoded = Convert.ToBase64String(bytes);
        Assert.True(
            encoded.Length > 66 * 1024 * 1024 && encoded.Length < ProviderServiceChannel.FrameLimit
        );
        await rig.Registry.RequestServiceAsync(
            "fixture/svc",
            "vscode-fs",
            "write-file",
            new()
            {
                ["path"] = file,
                ["contentBase64"] = encoded,
                ["create"] = true,
                ["overwrite"] = true,
            },
            default
        );
        Assert.Equal(SHA256.HashData(bytes), SHA256.HashData(File.ReadAllBytes(file)));
        var read = await rig.Fs("svc", "read-file", new() { ["path"] = file });
        Assert.Equal(
            SHA256.HashData(bytes),
            SHA256.HashData(Convert.FromBase64String(read["contentBase64"]!.ToString()))
        );
        Assert.Equal(1, rig.Count("connect"));
    }

    [Fact]
    public async Task Request_larger_than_the_frame_limit_is_refused_without_ending_the_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs(
                "svc",
                "write-file",
                new()
                {
                    ["path"] = Path.Combine(rig.Work, "x"),
                    ["contentBase64"] = new string('A', ProviderServiceChannel.FrameLimit),
                }
            )
        );
        Assert.Equal(("PayloadTooLarge", 413), (error.Code, error.Status));
        await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(1, rig.Count("connect"));
    }

    [Fact]
    public async Task Stderr_is_drained_and_never_ends_or_leaks_through_the_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig("stderr-flood");
        var stat = await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(2, stat["type"]!.GetValue<int>());
        Assert.Empty(rig.Disconnects);
    }

    [Fact]
    public async Task Rediscovery_that_removes_or_degrades_the_node_retires_its_live_channel()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var rig = new Rig();
        var target = await rig.Registry.ServiceAsync("fixture/svc", "vscode-fs", 1, default);
        await rig.Registry.RequestServiceAsync(
            target,
            "stat",
            new() { ["path"] = rig.Work },
            default
        );
        // Fast path: a live generation does not relaunch discovery.
        await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(1, rig.Count("oneShot", "list"));
        File.WriteAllText(Path.Combine(rig.Root, "offline"), "");
        await rig.Registry.ListAsync(default);
        Assert.Equal(target.ConnectionId, await rig.FirstDisconnectAsync());
        var error = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal("NodeUnavailable", error.Code);
        File.Delete(Path.Combine(rig.Root, "offline"));
        await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        Assert.Equal(2, rig.Count("connect"));
    }

    [Fact]
    public async Task Disposing_the_registry_closes_the_pipe_and_the_provider_sees_end_of_input()
    {
        if (!OperatingSystem.IsLinux())
            return;
        var rig = new Rig();
        await rig.Fs("svc", "stat", new() { ["path"] = rig.Work });
        var pid = rig.Log().Single(e => e.ContainsKey("connect"))["pid"]!.GetValue<int>();
        await rig.Registry.DisposeAsync();
        await Eventually(() => rig.Count("eof") == 1 ? "eof" : null);
        await Eventually(() => Directory.Exists("/proc/" + pid) ? null : "gone");
        var closed = await Assert.ThrowsAsync<CodeServiceException>(() =>
            rig.Fs("svc", "stat", new() { ["path"] = rig.Work })
        );
        Assert.Equal("NodeUnavailable", closed.Code);
        rig.Native.Dispose();
        rig.Temp.Dispose();
    }
}
