using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class NodeAuthorizationTreeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task First_provider_discovery_admits_children_before_roots_configuration_without_a_preparatory_list(bool exactResolution)
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        using var native = new NodeConnectionHub(data);
        var children = ExecutableNodeProviderTests.Configuration(Path.Combine(temp.Path, "children"));
        children["parentNode"] = "roots/target";
        var roots = ExecutableNodeProviderTests.Configuration(Path.Combine(temp.Path, "roots"));
        var registry = new NodeProviderRegistry(native, new JsonObject { ["children"] = children, ["roots"] = roots });
        Assert.Empty(native.Registry.ProviderRecords());
        if (exactResolution)
            Assert.NotNull(await registry.ResolveAsync("children/target", default));
        else
            Assert.Equal(6, (await registry.ListAsync(default)).Count);
        Assert.Equal(new[] { "children/target", "roots/target" }, native.Registry.Forest().Chain("children/target"));
        Assert.Null(native.Registry.Forest().Parent("roots/target"));
        Assert.Equal(6, native.Registry.ProviderRecords().Count);
        Assert.Contains(registry.Definitions("children/target"), definition => SessionWait.Text(definition?["name"]) == "read");
        var reopened = new ApprovedNodeRegistry(data);
        Assert.Equal(new[] { "children/target", "roots/target" }, reopened.Forest().Chain("children/target"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Initial_provider_snapshot_rejects_missing_parents_or_cycles_without_partial_registration(bool cycle)
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        using var native = new NodeConnectionHub(Path.Combine(temp.Path, "data"));
        var childPath = Path.Combine(temp.Path, "children");
        var rootPath = Path.Combine(temp.Path, "roots");
        var children = ExecutableNodeProviderTests.Configuration(childPath);
        children["parentNode"] = cycle ? "roots/target" : "roots/missing";
        var roots = ExecutableNodeProviderTests.Configuration(rootPath);
        if (cycle)
            roots["parentNode"] = "children/target";
        var registry = new NodeProviderRegistry(native, new JsonObject { ["children"] = children, ["roots"] = roots });
        var error = await Assert.ThrowsAsync<InvalidDataException>(() => registry.ListAsync(default));
        Assert.Contains(cycle ? "cycle" : "missing", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(native.Registry.ProviderRecords());
        Assert.Empty(registry.Snapshot());
        Assert.Empty(registry.Definitions("children/target"));
        Assert.Empty(registry.Definitions("roots/target"));
        foreach (var path in new[] { childPath, rootPath })
            Assert.Contains(await File.ReadAllLinesAsync(Path.Combine(path, "calls.jsonl")), line => Obj(line)["operation"]!.GetValue<string>() == "list");
    }
}
