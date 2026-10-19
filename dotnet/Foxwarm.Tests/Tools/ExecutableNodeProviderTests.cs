using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tests;

public sealed class ExecutableNodeProviderTests
{
    internal static string Script =>
        Path.Combine(AppContext.BaseDirectory, "Tools", "Fixtures", "node-provider.py");

    internal static JsonObject Configuration(
        string root,
        string mode = "normal",
        int timeout = 3
    ) =>
        new()
        {
            ["type"] = "executable",
            ["command"] = "python3",
            ["args"] = new JsonArray(Script, root, mode),
            ["timeoutSeconds"] = (double)timeout,
        };

    [Fact]
    public async Task Actual_discovery_qualifies_only_Core_identities_derives_file_capabilities_and_retains_native_owners()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        using var temp = new TempDirectory();
        using var native = new NodeConnectionHub(Path.Combine(temp.Path, "main"));
        native.Registry.Create("offline-native");
        var registry = new NodeProviderRegistry(
            native,
            new JsonObject
            {
                ["one"] = Configuration(Path.Combine(temp.Path, "one")),
                ["two"] = Configuration(Path.Combine(temp.Path, "two")),
            }
        );
        var nodes = await registry.ListAsync(default);
        Assert.Equal(6, nodes.Count);
        Assert.Contains(nodes, value => value?["id"]?.GetValue<string>() == "one/target");
        Assert.Contains(nodes, value => value?["id"]?.GetValue<string>() == "two/target");
        Assert.Equal(
            new[] { "read", "write", "edit", "apply_patch" },
            registry.Definitions("one/target").Select(value => value!["name"]!.GetValue<string>())
        );
        Assert.Single(registry.Definitions("one/readonly"));
        Assert.Empty(registry.Definitions("one/offline"));
        Assert.Empty(registry.Definitions("one/missing"));
        Assert.NotNull(await registry.ResolveAsync("master", default));
        Assert.NotNull(await registry.ResolveAsync("offline-native", default));
        Assert.Null(await registry.ResolveAsync("missing/target", default));
        Assert.Empty(nodes[0]!["services"]!.AsObject());
        var provider = new ExecutableNodeProvider("one", Configuration(temp.Path));
        var description = await provider.DescribeAsync(default);
        Assert.Empty(description["lifecycle"]!.AsArray());
        await provider.DescribeAsync(default);
        var requests = (
            await File.ReadAllLinesAsync(Path.Combine(temp.Path, "calls.jsonl"))
        ).Select(line => JsonNode.Parse(line)!);
        Assert.Single(requests, value => value["operation"]!.GetValue<string>() == "describe");
        Assert.All(requests, value => Assert.False(value["environmentLeak"]!.GetValue<bool>()));
    }

    [Theory]
    [InlineData("multiple", "NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE")]
    [InlineData("identity", "NODE_PROVIDER_REQUEST_MISMATCH")]
    [InlineData("exit", "NODE_PROVIDER_PROCESS_EXIT")]
    [InlineData("stdout", "NODE_PROVIDER_OUTPUT_LIMIT")]
    [InlineData("stderr", "NODE_PROVIDER_STDERR_LIMIT")]
    [InlineData("hang", "NODE_PROVIDER_TIMEOUT")]
    [InlineData("inherited", "NODE_PROVIDER_PROCESS_CLOSE_TIMEOUT")]
    [InlineData("duplicate", "NODE_PROVIDER_DUPLICATE_NODE")]
    public async Task Real_process_failures_are_bounded_safe_and_never_replayed(
        string mode,
        string expected
    )
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        using var temp = new TempDirectory();
        var provider = new ExecutableNodeProvider("fixture", Configuration(temp.Path, mode, 1));
        var clock = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<NodeProviderException>(() =>
            provider.ListAsync(default)
        );
        Assert.Equal(expected, error.Code);
        Assert.DoesNotContain("private launcher", error.Message);
        Assert.DoesNotContain(temp.Path, error.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), clock.Elapsed.ToString());
        Assert.Single(await File.ReadAllLinesAsync(Path.Combine(temp.Path, "calls.jsonl")));
    }

    [Fact]
    public async Task Cancellation_and_eight_request_admission_do_not_block_fixed_native_lookup()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        using var temp = new TempDirectory();
        var provider = new ExecutableNodeProvider("fixture", Configuration(temp.Path, "hang", 5));
        using var stop = new CancellationTokenSource();
        var tasks = Enumerable.Range(0, 8).Select(_ => provider.ListAsync(stop.Token)).ToArray();
        var ninth = await Assert.ThrowsAsync<NodeProviderException>(() =>
            provider.ListAsync(default)
        );
        Assert.Equal("NODE_PROVIDER_BACKPRESSURE", ninth.Code);
        stop.Cancel();
        foreach (var task in tasks)
            Assert.Equal(
                "NODE_PROVIDER_CANCELLED",
                (await Assert.ThrowsAsync<NodeProviderException>(() => task)).Code
            );
        using var native = new NodeConnectionHub(Path.Combine(temp.Path, "native"));
        native.Registry.Create("offline");
        var registry = new NodeProviderRegistry(
            native,
            new JsonObject { ["broken"] = Configuration(temp.Path, "hang", 1) }
        );
        Assert.NotNull(await registry.ResolveAsync("master", default));
        Assert.NotNull(await registry.ResolveAsync("offline", default));
        Assert.False(File.Exists(Path.Combine(temp.Path, "native", "calls.jsonl")));
    }

    [Fact]
    public async Task Full_qualified_identity_bound_and_native_credentials_remain_separate()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        using var temp = new TempDirectory();
        var local = new string('n', 128);
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "node-id"), local);
        var id = new string('p', 64);
        using var native = new NodeConnectionHub(Path.Combine(temp.Path, "native"));
        var registry = new NodeProviderRegistry(
            native,
            new JsonObject { [id] = Configuration(temp.Path) }
        );
        var qualified = id + "/" + local;
        NodeProviderRegistry.ValidateId(qualified);
        Assert.NotNull(await registry.ResolveAsync(qualified, default));
        Assert.Equal(193, qualified.Length);
        Assert.Throws<InvalidDataException>(() => ApprovedNodeRegistry.ValidateId(qualified));
        Assert.Throws<InvalidDataException>(() => NodeProviderRegistry.ValidateId(qualified + "n"));
        Assert.Throws<InvalidDataException>(() => NodeProviderRegistry.ValidateId("p/n/tool"));
    }

    [Fact]
    public async Task Oversized_request_is_rejected_before_process_effect_and_releases_admission()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var provider = new ExecutableNodeProvider("fixture", Configuration(temp.Path));
        var error = await Assert.ThrowsAsync<NodeProviderException>(() =>
            provider.RunAsync(
                "filesystem",
                new JsonObject { ["path"] = new string('x', 4 * 1024 * 1024) },
                default
            )
        );
        Assert.Equal("NODE_PROVIDER_REQUEST_LIMIT", error.Code);
        Assert.False(File.Exists(Path.Combine(temp.Path, "calls.jsonl")));
        await provider.ListAsync(default);
        Assert.Single(await File.ReadAllLinesAsync(Path.Combine(temp.Path, "calls.jsonl")));
    }
}
