using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    [Fact]
    public async Task Master_copy_resolves_relative_paths_against_session_cwd_only_when_master_is_current()
    {
        await using var f = new Fixture();
        await f.Start();
        var project = Path.Combine(f.Temp.Path, "project");
        Directory.CreateDirectory(project);
        await f.Owner.Entry.SaveLane.CommitCwdAsync(project);
        byte[] bytes = [0, 1, 255];
        await File.WriteAllBytesAsync(Path.Combine(project, "binary"), bytes);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "binary"), [9]);
        JsonObject Args() =>
            new()
            {
                ["sourceNode"] = "master",
                ["sourcePath"] = "binary",
                ["targetNode"] = "master",
                ["targetPath"] = "nested/copy",
            };

        // Master is the current Node: the Session working directory is the basis.
        await f.Manager.CopyBetweenNodesAsync(f.Owner, Args(), default);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(project, "nested/copy")));
        Assert.False(File.Exists(Path.Combine(f.Work, "nested/copy")));
        await Assert.ThrowsAsync<IOException>(() =>
            f.Manager.CopyBetweenNodesAsync(f.Owner, Args(), default)
        );

        // Another Node is current: master endpoints use the Agent directory.
        await f.Manager.CopyBetweenNodesAsync(f.Owner, Args(), default, "elsewhere", project);
        Assert.Equal([9], await File.ReadAllBytesAsync(Path.Combine(f.Work, "nested/copy")));
    }

    [Fact]
    public async Task Copy_sends_session_cwd_only_to_the_current_Node()
    {
        await using var f = new Fixture();
        await f.Start();
        var one = await f.Connect("one");
        var two = await f.Connect("two");
        byte[] bytes = [1, 2, 3];
        var copy = f.Manager.CopyBetweenNodesAsync(
            f.Owner,
            new JsonObject
            {
                ["sourceNode"] = "one",
                ["sourcePath"] = "in.bin",
                ["targetNode"] = "two",
                ["targetPath"] = "out.bin",
            },
            default,
            "one",
            "/work/project"
        );
        var read = await Fixture.Read(one);
        Assert.Equal("file_read_request", read["type"]!.GetValue<string>());
        Assert.Equal("/work/project", read["sessionCwd"]!.GetValue<string>());
        await Fixture.Send(one, Fixture.Reply(read, bytes));
        var write = await Fixture.Read(two);
        Assert.Equal("file_write_request", write["type"]!.GetValue<string>());
        Assert.False(write.ContainsKey("sessionCwd"));
        await Fixture.Send(two, Fixture.Reply(write, bytes, true));
        Assert.Null((await copy)["error"]);
    }

    [Fact]
    public async Task Transfer_frames_omit_session_cwd_without_one()
    {
        await using var f = new Fixture();
        await f.Start();
        var one = await f.Connect("one");
        var pending = f.Manager.Nodes.ReadFileAsync("one", "x", f.Owner, false, default);
        var plain = await Fixture.Read(one);
        Assert.False(plain.ContainsKey("sessionCwd"));
        await Fixture.Send(one, Fixture.Reply(plain, [1]));
        await pending;

        pending = f.Manager.Nodes.ReadFileAsync(
            "one",
            "x",
            f.Owner,
            false,
            default,
            sessionCwd: "C:\\work\\project"
        );
        var scoped = await Fixture.Read(one);
        Assert.Equal("C:\\work\\project", scoped["sessionCwd"]!.GetValue<string>());
        await Fixture.Send(one, Fixture.Reply(scoped, [1]));
        await pending;
    }
}
