using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Cancelling_a_provider_write_leaves_the_completed_prefix_without_replay()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create("slow");
        var source = Path.Combine(f.Work, "source.bin");
        Directory.CreateDirectory(f.Work);
        await using (
            var file = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.None)
        )
            file.SetLength(16 * 1024 * 1024);
        var copy = await f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            new JsonObject
            {
                ["sourceNode"] = "master",
                ["sourcePath"] = "source.bin",
                ["targetNode"] = f.Node,
                ["targetPath"] = "partial.bin",
                ["timeout"] = 1,
            },
            default
        );
        var id = copy["transferId"]!.ToString();
        var target = f.FilePath("partial.bin");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (!File.Exists(target) || new FileInfo(target).Length == 0)
            await Task.Delay(25, deadline.Token);
        f.Owner.Entry.WithState(state => state.Busy = true);
        _ = await f.Manager.CancelCopyTransferAsync(
            f.Owner,
            new JsonObject { ["transferId"] = id },
            default
        );
        while (
            !f.Owner.Entry.WithState(state =>
                state.Queue.Any(item => SessionWait.Text(item.OpenFields?["execId"]) == id)
            )
        )
            await Task.Delay(25, deadline.Token);
        Assert.InRange(new FileInfo(target).Length, 1, 16 * 1024 * 1024 - 1);
        f.Owner.Entry.WithState(state => state.Busy = false);
    }

    [Fact]
    public async Task Provider_and_resident_CLI_copy_in_both_directions_over_streams()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", f.Manager.Nodes.HandleAsync);
        f.Manager.Nodes.RegisterFileStreamRoutes(app);
        await app.StartAsync();
        var credentials = f.Manager.Nodes.Registry.Create("provider-peer");
        var root = Path.Combine(f.Temp.Path, "provider-peer");
        Directory.CreateDirectory(root);
        var client = new Foxwarm.CliNode.NodeClient(
            new Foxwarm.CliNode.NodeClientOptions(
                app.Urls.Single(),
                "provider-peer",
                null,
                credentials["authToken"]!.ToString(),
                null,
                LocalTrigger: false
            ),
            new Foxwarm.CliNode.NodePaths(root)
        );
        using var stop = new CancellationTokenSource();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        void Changed()
        {
            if (f.Manager.Nodes.Online("provider-peer"))
                ready.TrySetResult();
        }
        f.Manager.Nodes.Changed += Changed;
        var running = client.Run(stop.Token);
        try
        {
            Changed();
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            const long length = 105L * 1024 * 1024 + 9;
            var source = f.FilePath("large.bin");
            Directory.CreateDirectory(Path.GetDirectoryName(source)!);
            await using (
                var file = new FileStream(
                    source,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                )
            )
            {
                file.SetLength(length);
                file.Position = length - 1;
                await file.WriteAsync(new byte[] { 41 });
            }
            var args = new JsonObject
            {
                ["sourceNode"] = f.Node,
                ["sourcePath"] = "large.bin",
                ["targetNode"] = "provider-peer",
                ["targetPath"] = Path.Combine(root, "large.bin"),
            };
            var first = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            args["sourceNode"] = "provider-peer";
            args["sourcePath"] = Path.Combine(root, "large.bin");
            args["targetNode"] = f.Node;
            args["targetPath"] = "copy.bin";
            var second = await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
            Assert.Equal(length, second["sizeBytes"]!.GetValue<long>());
            Assert.Equal(first["sha256"]!.ToString(), second["sha256"]!.ToString());
            await using var original = File.OpenRead(source);
            await using var result = File.OpenRead(f.FilePath("copy.bin"));
            Assert.Equal(await SHA256.HashDataAsync(original), await SHA256.HashDataAsync(result));
        }
        finally
        {
            stop.Cancel();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            f.Manager.Nodes.Changed -= Changed;
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Generic_copy_above_upload_limit_uses_bounded_primitive_chunks_without_a_whole_file_cap()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await Fixture.Create();
        var bytes = new byte[60 * 1024 * 1024];
        for (var index = 0; index < bytes.Length; index++)
            bytes[index] = (byte)(index * 31);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), bytes);
        var args = new JsonObject
        {
            ["sourceNode"] = "master",
            ["sourcePath"] = "source.bin",
            ["targetNode"] = f.Node,
            ["targetPath"] = "nested/provider.bin",
        };
        Success(await f.Call("copy_between_nodes", args));
        args["sourceNode"] = f.Node;
        args["sourcePath"] = "nested/provider.bin";
        args["targetNode"] = "master";
        args["targetPath"] = "roundtrip.bin";
        Success(await f.Call("copy_between_nodes", args));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "roundtrip.bin")));
        var requests = await f.Requests();
        var reads = requests
            .Where(call => call["request"]?["operation"]?.ToString() == "read")
            .ToArray();
        var writes = requests
            .Where(call => call["request"]?["operation"]?.ToString() == "write")
            .ToArray();
        Assert.True(reads.Length > 1 && writes.Length > 1);
        Assert.All(
            reads,
            call => Assert.InRange(call["request"]!["count"]!.GetValue<int>(), 1, 1024 * 1024)
        );
        Assert.All(
            writes,
            call => Assert.InRange(call["writeBytes"]!.GetValue<int>(), 1, 1024 * 1024)
        );
        Assert.Equal("wx", writes[0]["request"]!["flag"]!.ToString());
        Assert.All(writes.Skip(1), call => Assert.Equal("a", call["request"]!["flag"]!.ToString()));
    }
}
