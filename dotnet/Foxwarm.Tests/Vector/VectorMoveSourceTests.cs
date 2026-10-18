using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorMoveSourceTests
{
    [Fact]
    public async Task Frozen_Source_demonstrates_old_agent_dense_metadata_after_a_supported_cross_agent_move()
    {
        await using var f = await VectorFixture.CreateAsync();
        var input = new JsonObject { ["config"] = new JsonObject { ["vector"] = new JsonObject { ["baseUrl"] = f.Peer.BaseUrl }, ["dbWorkers"] = false, ["vectorMaintenance"] = false } };
        var inputPath = Path.Combine(f.Temp.Path, "move-input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var result = await VectorFixture.SourceAsync("move-scope", Path.Combine(f.Temp.Path, "source-move"), inputPath, Path.Combine(f.Temp.Path, "source-move.json"));
        Assert.NotEmpty(result["before"]!.AsArray());
        Assert.NotEmpty(result["after"]!.AsArray());
        Assert.Empty(result["destination"]!.AsArray());
        Assert.Contains("transferred authority marker", result["implicit"]!.ToJsonString());
        Assert.Contains("outside the current agent", result["explicit"]!.ToJsonString());
        Assert.Equal("destination/moved", result["moved"]!["targetSessionId"]!.GetValue<string>());
    }
}
