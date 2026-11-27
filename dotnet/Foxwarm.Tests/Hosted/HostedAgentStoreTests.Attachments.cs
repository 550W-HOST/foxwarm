using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Hosted;

public sealed partial class HostedAgentStoreTests
{
    [Fact]
    public async Task An_upload_and_received_files_are_readable_after_old_spills_expire()
    {
        await using var f = await StoreFixture.Create(store: true);
        var uploads = new WebUiUploadedFiles(f.Manager);
        Directory.CreateDirectory(uploads.Root);
        var source = Path.Combine(uploads.Root, "document.txt");
        await File.WriteAllTextAsync(source, "uploaded");
        var upload = await uploads.PrepareAsync(new() { ["uploadedFiles"] = new JsonArray(JsonValue.Create(source)) }, f.Inner.Owner, default);
        var receipt = Assert.Single(upload.SavedFiles);
        Assert.Equal("@agent", SessionWait.Text(receipt["node"]));
        var path = SessionWait.Text(receipt["path"])!;
        Assert.StartsWith("$fw_agentdir/.temp/channel-files/webui/", path);
        Assert.Contains("node=\"@agent\"", SessionWait.Text(Assert.Single(upload.Parts)["text"]));
        Assert.False(File.Exists(source));
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
        var image = await f.Manager.SaveInboundChannelFileAsync("telegram", "room", png, "dot.png", "image/png", "caption", default);
        Assert.StartsWith("caption\n\n<foxwarm-image", SessionWait.Text(image[0]["text"]));
        Assert.Contains("node=\"@agent\"", SessionWait.Text(image[0]["text"]));
        Assert.NotNull(image[1]["inlineDataRef"]);
        var spilled = await f.Inner.Tools.SaveToolOutputAsync("whole output", "master", "", default);
        Assert.Equal("@agent", spilled.Node);
        var key = spilled.Path["$fw_agentdir/".Length..];
        Assert.Equal("whole output", await f.Store.ReadTextAsync("main", key, default));
        var modified = f.Store.Stat("main", key)!.LastWriteUtc;
        Assert.Equal(0, await f.Manager.SweepToolOutputAsync(modified.AddHours(24), default));
        Assert.Equal(1, await f.Manager.SweepToolOutputAsync(modified.AddHours(24).AddSeconds(1), default));
        Assert.False(f.Store.FileExists("main", key));
        Assert.Equal("uploaded", await f.Store.ReadTextAsync("main", path["$fw_agentdir/".Length..], default));
        var savedImage = Assert.Single(f.Store.List("main", ".temp/channel-files/telegram"));
        Assert.Equal(png, (await f.Store.ReadAsync("main", ".temp/channel-files/telegram/" + savedImage.Name, default)).Bytes);
    }

    // This stream has no declared length, so admission must stop on the first excess byte.
    private sealed class Chunked(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }

    [Theory]
    [InlineData(8, 32)]
    [InlineData(32, 8)]
    public async Task Known_and_unknown_lengths_are_bounded_before_channel_storage(long uploadLimit, long storeLimit)
    {
        await using var f = await StoreFixture.Create(store: true, capabilities: RuntimeCapabilities.Hosted with { Limits = Foxwarm.Limits.TenantLimits.Defaults with { UploadBytes = uploadLimit } });
        f.Postgres!.AgentStoreLimits = () => AgentStoreLimits.Default with { FileBytes = storeLimit };
        var uploads = new WebUiUploadedFiles(f.Manager);
        Assert.Equal(8, uploads.UploadLimit);
        Directory.CreateDirectory(uploads.Root);
        var staged = Path.Combine(uploads.Root, "over.txt");
        await File.WriteAllTextAsync(staged, "0123456789");
        var refused = await Assert.ThrowsAsync<UploadPreparationException>(() => uploads.PrepareAsync(new() { ["filePaths"] = new JsonArray(JsonValue.Create(staged)) }, f.Inner.Owner, default));
        Assert.Contains("This file is larger than the 8 bytes upload limit.", refused.Message);
        foreach (var known in new[] { true, false })
        {
            using var stream = new Chunked(new byte[32]);
            using var content = new StreamContent(stream);
            if (known)
                content.Headers.ContentLength = 32;
            var notice = await f.Manager.SaveRemoteChannelFileAsync("matrix", "room", () => f.Manager.ReadChannelBodyAsync(content, default), "f", "text/plain", "caption", default);
            Assert.Contains(known ? "(text/plain, 32 bytes)" : "(text/plain, more than 8 bytes)", SessionWait.Text(Assert.Single(notice)["text"]));
            Assert.Equal(known ? 0 : 9, stream.Position);
        }
        Assert.Empty(f.Store.List("main", ".temp/channel-files"));
    }

    [Fact]
    public async Task A_received_file_refused_by_the_store_quota_keeps_its_caption_and_reason()
    {
        await using var f = await StoreFixture.Create(store: true);
        var (_, count) = ((PgAgentFileStore)f.Store).Usage();
        f.Postgres!.AgentStoreLimits = () => AgentStoreLimits.Default with { Files = count };
        var parts = await f.Manager.SaveInboundChannelFileAsync("telegram", "room", [1], "limit.dat", "text/plain", "caption", default);
        Assert.Equal($"caption\n\n[Received file not kept: \"limit.dat\" (text/plain, 1 bytes). {AgentFileErrors.TooManyFiles(f.Store.Limits).Message}]", SessionWait.Text(Assert.Single(parts)["text"]));
        Assert.Empty(f.Store.List("main", ".temp/channel-files/telegram"));
    }

    [Theory]
    [InlineData(false, "Use read to inspect it.")]
    [InlineData(true, "Use node:@agent/read to inspect it.")]
    public async Task A_guarded_result_names_the_read_that_reaches_its_folder(bool selected, string instruction)
    {
        await using var f = await StoreFixture.Create(store: true);
        var owner = selected ? await f.Manager.CreateNamedAsync("main", "selected", null, null, initialNode: "elsewhere") : f.Inner.Owner;
        var tools = f.Inner.Executor(owner);
        var complete = new string('x', 50_000);
        var output = await ToolOutputGuard.GuardAsync(new JsonObject { ["output"] = complete }, text => tools.SaveToolOutputAsync(text, "@agent", "", default));
        Assert.Contains(instruction, SessionWait.Text(output!["output"]));
        Assert.Equal("@agent", SessionWait.Text(output["outputFullNode"]));
        var path = SessionWait.Text(output["outputFullPath"])!;
        Assert.Equal(complete, await f.Store.ReadTextAsync("main", path["$fw_agentdir/".Length..], default));
    }
}
