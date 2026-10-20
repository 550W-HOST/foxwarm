using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task Artifact_resident_source_keeps_approved_read_cwd_and_correlated_complete_transfer_not_preview_text()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await f.Connect("resident");
        await f.Manager.SelectNodeAsync(f.Owner, "resident");
        await f.Owner.UpdateCwdAsync("/remote/captured");
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var registry = SessionToolExecutor.CreateRegistry(new JsonArray(ArtifactToolDefinition.Definition()), mcp, _ => f.Work, f.Manager.Nodes, f.Manager.NodeProviders);
        var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
        var running = tools.ExecuteAsync(new JsonObject { ["name"] = "artifact", ["args"] = new JsonObject { ["action"] = "prepare", ["filePath"] = "chart.json" } }, default);
        var read = await Fixture.Read(socket);
        Assert.Equal("tool_call", SessionWait.Text(read["type"]));
        Assert.Equal("read", SessionWait.Text(read["tool"]));
        Assert.Equal("chart.json", SessionWait.Text(read["args"]?["filePath"]));
        Assert.Equal("/remote/captured", SessionWait.Text(read["sessionCwd"]));
        await Fixture.Send(socket, new JsonObject { ["type"] = "tool_call_response", ["callId"] = read["callId"]!.DeepClone(), ["result"] = new JsonObject { ["output"] = "not a JSON manifest: bounded display preview", ["filePath"] = "/remote/resolved/chart.json" } });
        var transfer = await Fixture.Read(socket);
        Assert.Equal("file_read_request", SessionWait.Text(transfer["type"]));
        Assert.Equal("/remote/resolved/chart.json", SessionWait.Text(transfer["filePath"]));
        var bytes = Encoding.UTF8.GetBytes(ArtifactStoreTests.Chart("Resident snapshot").ToJsonString());
        await Fixture.Send(socket, Fixture.Reply(transfer, bytes));
        var result = (await running.WaitAsync(TimeSpan.FromSeconds(20)))!.AsObject();
        Assert.Null(result["error"]);
        Assert.Equal("Resident snapshot", SessionWait.Text(result["preparedArtifact"]?["title"]));
        var id = SessionWait.Text(result["preparedArtifact"]?["artifactId"])!;
        Assert.Equal(f.Owner.Id, SessionWait.Text((await f.Manager.Artifacts.ReadAsync(id, 1, f.Owner.Id))["receipt"]?["sessionId"]));
    }
}
