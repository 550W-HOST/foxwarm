using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task Authorized_master_copy_above_WebUI_upload_limit_preserves_complete_bytes_and_no_overwrite()
    {
        await using var f = new Fixture();
        await f.Start();
        var bytes = new byte[60 * 1024 * 1024];
        for (var index = 0; index < bytes.Length; index++)
            bytes[index] = (byte)(index * 17);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), bytes);
        var args = new JsonObject
        {
            ["sourceNode"] = "master", ["sourcePath"] = "source.bin",
            ["targetNode"] = "master", ["targetPath"] = "nested/destination.bin",
        };
        var result = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
        Assert.Equal(bytes.Length, result["sizeBytes"]!.GetValue<int>());
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "nested/destination.bin")));
        await Assert.ThrowsAsync<IOException>(() => f.Manager.CopyBetweenNodesAsync(f.Owner, args, default));
    }
    [Fact]
    public async Task Real_resident_CLI_complete_transfer_above_upload_limit_roundtrips_through_generic_copy()
    {
        await using var f = new Fixture();
        await f.Start();
        var credentials = f.Manager.Nodes.Registry.Create("resident-cli");
        var target = Path.Combine(f.Temp.Path, "cli");
        Directory.CreateDirectory(target);
        var client = new Foxwarm.CliNode.NodeClient(
            new Foxwarm.CliNode.NodeClientOptions(f.App.Urls.Single(), "resident-cli", null,
                credentials["authToken"]!.ToString(), null, LocalTrigger: false),
            new Foxwarm.CliNode.NodePaths(target));
        using var stop = new CancellationTokenSource();
        var registered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Changed()
        {
            if (f.Manager.Nodes.List().Any(node => node?["id"]?.ToString() == "resident-cli" && node?["executable"]?.GetValue<bool>() == true))
                registered.TrySetResult();
        }
        f.Manager.Nodes.Changed += Changed;
        var running = client.Run(stop.Token);
        try
        {
            await registered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var bytes = new byte[60 * 1024 * 1024];
            bytes[0] = 255; bytes[^1] = 117;
            await File.WriteAllBytesAsync(Path.Combine(f.Work, "resident-source.bin"), bytes);
            var args = new JsonObject
            {
                ["sourceNode"] = "master", ["sourcePath"] = "resident-source.bin",
                ["targetNode"] = "resident-cli", ["targetPath"] = "nested/resident.bin",
            };
            await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            args["sourceNode"] = "resident-cli"; args["sourcePath"] = "nested/resident.bin";
            args["targetNode"] = "master"; args["targetPath"] = "roundtrip.bin";
            await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "roundtrip.bin")));
        }
        finally
        {
            stop.Cancel();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            f.Manager.Nodes.Changed -= Changed;
        }
    }
}
