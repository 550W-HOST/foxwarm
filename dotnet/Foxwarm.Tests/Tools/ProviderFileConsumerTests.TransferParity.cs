using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Generic_copy_above_upload_limit_uses_bounded_primitive_chunks_without_a_whole_file_cap()
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create();
        var bytes = new byte[60 * 1024 * 1024];
        for (var index = 0; index < bytes.Length; index++) bytes[index] = (byte)(index * 31);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "source.bin"), bytes);
        var args = new JsonObject
        {
            ["sourceNode"] = "master", ["sourcePath"] = "source.bin",
            ["targetNode"] = f.Node, ["targetPath"] = "nested/provider.bin",
        };
        Success(await f.Call("copy_between_nodes", args));
        args["sourceNode"] = f.Node; args["sourcePath"] = "nested/provider.bin";
        args["targetNode"] = "master"; args["targetPath"] = "roundtrip.bin";
        Success(await f.Call("copy_between_nodes", args));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "roundtrip.bin")));
        var requests = await f.Requests();
        var reads = requests.Where(call => call["request"]?["operation"]?.ToString() == "read").ToArray();
        var writes = requests.Where(call => call["request"]?["operation"]?.ToString() == "write").ToArray();
        Assert.True(reads.Length > 1 && writes.Length > 1);
        Assert.All(reads, call => Assert.InRange(call["request"]!["count"]!.GetValue<int>(), 1, 1024 * 1024));
        Assert.All(writes, call => Assert.InRange(call["writeBytes"]!.GetValue<int>(), 1, 1024 * 1024));
        Assert.Equal("wx", writes[0]["request"]!["flag"]!.ToString());
        Assert.All(writes.Skip(1), call => Assert.Equal("a", call["request"]!["flag"]!.ToString()));
    }
}
