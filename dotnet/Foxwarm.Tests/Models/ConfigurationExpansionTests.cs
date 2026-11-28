using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ConfigurationExpansionTests
{
    [Fact]
    public void EveryAliasOccurrenceCountsTowardExpandedNodesAndUtf8Bytes()
    {
        const string yaml = "x: &x [猫, hi]\ny: *x\n";
        Assert.Equal("猫", (string?)ConfigurationYaml.Parse(yaml, "config")["y"]![0]);
        Assert.Throws<InvalidDataException>(() => ConfigurationYaml.Parse(yaml, "config", nodes: 8));
        Assert.Throws<InvalidDataException>(() => ConfigurationYaml.Parse(yaml, "config", scalarBytes: 11));
    }

    [Fact]
    public void MergeWorkAndExpandedDepthAreBounded()
    {
        const string yaml = "base: &base {k: v}\nsection: {<<: *base}";
        Assert.Equal("v", (string?)ConfigurationYaml.Parse(yaml, "config")["section"]!["k"]);
        Assert.Throws<InvalidDataException>(() => ConfigurationYaml.Parse(yaml, "config", mergeWork: 0));
        Assert.Throws<InvalidDataException>(() => ConfigurationYaml.Parse("x: &x [[1]]\ny: [[*x]]", "config", depth: 4));
    }

    [Fact]
    public async Task SaveKeepsPreviousDocumentWhenDepthIsExceeded()
    {
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(temp.Path);
        await config.SaveAppAsync("bot: {name: First}\n");
        var previous = config.ReadCurrentAppRaw();
        await Assert.ThrowsAsync<InvalidDataException>(() => config.SaveAppAsync("other: " + new string('[', 80) + "0" + new string(']', 80)));
        Assert.Equal(previous, config.ReadCurrentAppRaw());
    }
}
