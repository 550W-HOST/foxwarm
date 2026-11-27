using System.Text.Json.Nodes;
using Foxwarm.Limits;

namespace Foxwarm.Tests;

// The tenant's limit on calls in flight to resident Nodes is taken at dispatch.
public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task ALegacyBatchEditReadsItsSourceBeforeTakingItsCallSlot()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, false);
        var slots = new AdmissionSlots(1);
        f.Manager.Nodes.AdmitCall = slots.EnterAsync;
        var args = new JsonObject
        {
            ["filePath"] = "file",
            ["oldText"] = "a",
            ["newText"] = "b",
            ["replaceAll"] = true,
        };
        var running = RemoteEdit(f, args);
        var read = await Fixture.Read(socket).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("read", read["tool"]!.GetValue<string>());
        await RespondEdit(
            socket,
            read,
            new JsonObject
            {
                ["content"] = "a a",
                ["sizeBytes"] = 3,
                ["selectedBytes"] = 3,
                ["truncated"] = false,
            }
        );
        var edit = await Fixture.Read(socket).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("edit", edit["tool"]!.GetValue<string>());
        Assert.Equal(1, slots.InUse);
        // A second call waits for the slot until the edit's reply.
        var second = f.Manager.NodeProviders.ExecuteAsync(
            "edit-peer",
            "read",
            new JsonObject { ["filePath"] = "other" },
            f.Owner.Id,
            f.Owner.Agent,
            "edit-peer",
            "/peer/project",
            false,
            default,
            f.Owner
        );
        await Task.Delay(100);
        Assert.False(second.IsCompleted);
        await RespondEdit(socket, edit);
        Assert.NotNull(await running.WaitAsync(TimeSpan.FromSeconds(5)));
        var secondRead = await Fixture.Read(socket).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("read", secondRead["tool"]!.GetValue<string>());
        await RespondEdit(socket, secondRead, new JsonObject { ["content"] = "x", ["sizeBytes"] = 1, ["selectedBytes"] = 1, ["truncated"] = false });
        await second.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, slots.InUse);
    }
}
