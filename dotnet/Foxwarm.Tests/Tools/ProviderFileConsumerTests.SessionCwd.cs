using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Copy_and_delivery_pass_session_cwd_to_the_current_Provider_Node_only()
    {
        if (!OperatingSystem.IsLinux())
            return; // Independent executable qualification is Linux-only.
        await using var f = await Fixture.Create();
        await f.Seed("sub/data.txt", Encoding.UTF8.GetBytes("payload"));
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        string?[] Contexts(IEnumerable<JsonObject> calls) =>
            calls
                .Where(call => call["operation"]!.GetValue<string>() == "filesystem")
                .Select(call => SessionWait.Text(call["request"]!["context"]!["cwd"]))
                .ToArray();

        // The Provider Node is current and has a working directory.
        await f.Manager.SelectNodeAsync(f.Owner, f.Node);
        await f.Owner.UpdateCwdAsync("opaque://root/sub");
        var before = (await f.Requests()).Length;
        Success(
            await f.Call(
                "copy_between_nodes",
                new JsonObject
                {
                    ["sourceNode"] = f.Node,
                    ["sourcePath"] = "data.txt",
                    ["targetNode"] = "master",
                    ["targetPath"] = "from-provider.txt",
                }
            )
        );
        var current = Contexts((await f.Requests()).Skip(before));
        Assert.NotEmpty(current);
        Assert.All(current, cwd => Assert.Equal("opaque://root/sub", cwd));
        before = (await f.Requests()).Length;
        Success(await f.Call("send_file", new JsonObject { ["filePath"] = "data.txt" }));
        Assert.All(
            Contexts((await f.Requests()).Skip(before)),
            cwd => Assert.Equal("opaque://root/sub", cwd)
        );

        // Master is current: the Provider Node is another Node and gets no Session cwd.
        await f.Manager.SelectNodeAsync(f.Owner, "master");
        before = (await f.Requests()).Length;
        Success(
            await f.Call(
                "copy_between_nodes",
                new JsonObject
                {
                    ["sourceNode"] = f.Node,
                    ["sourcePath"] = "sub/data.txt",
                    ["targetNode"] = "master",
                    ["targetPath"] = "again.txt",
                }
            )
        );
        var other = Contexts((await f.Requests()).Skip(before));
        Assert.NotEmpty(other);
        Assert.All(other, cwd => Assert.Null(cwd));
    }
}
