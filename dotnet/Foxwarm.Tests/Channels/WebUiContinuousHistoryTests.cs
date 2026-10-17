using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiContinuousHistoryTests
{
    private static ArchiveMessageRecord Raw(string owner, long seq) => ArchiveMessageRecord.Create(
        owner, "main", seq, seq == 10 ? 123 : seq * 1000, new JsonObject
        {
            ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "original " + seq }),
            ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq == 10 ? 123 : seq * 1000 },
        });
    private static long[] Sequences(JsonObject page) => page["messages"]!.AsArray().Select(row => row!["__meta"]!["seq"]!.GetValue<long>()).ToArray();

    [Fact]
    public void Reopened_original_archive_pages_are_bounded_ordered_and_obey_snapshot_and_cumulative_fork_alias_caps()
    {
        using var temp = new TempDirectory();
        var db = Path.Combine(temp.Path, "archive.sqlite");
        var parent = new SqliteArchiveMessageStore(db, "parent"); parent.Initialize(); parent.EnsureBranch();
        parent.WriteMessages(Enumerable.Range(1, 240).Select(seq => Raw("parent", seq)).ToArray());
        var child = new SqliteArchiveMessageStore(db, "child"); child.EnsureBranch("parent", 205, 0);
        child.WriteMessages(Enumerable.Range(206, 10).Select(seq => Raw("child", seq)).ToArray());
        var nested = new SqliteArchiveMessageStore(db, "nested"); nested.EnsureBranch("child", 210, 0);
        nested.WriteMessages([Raw("nested", 211)]);
        // Reopen the durable fork reader rather than populating any active Session history.
        nested = new SqliteArchiveMessageStore(db, "nested");
        var latest = WebUiContinuousHistory.Read(nested, null, null, 211);
        Assert.Equal(Enumerable.Range(112, 100).Select(x => (long)x), Sequences(latest));
        Assert.True(latest["hasMore"]!.GetValue<bool>());
        var older = WebUiContinuousHistory.Read(nested, 112, null, 211);
        Assert.Equal(Enumerable.Range(12, 100).Select(x => (long)x), Sequences(older));
        var first = WebUiContinuousHistory.Read(nested, 12, null, 211);
        Assert.Equal(Enumerable.Range(1, 11).Select(x => (long)x), Sequences(first));
        Assert.False(first["hasMore"]!.GetValue<bool>());
        Assert.Equal(123, first["messages"]![9]!["__meta"]!["timestamp"]!.GetValue<int>());
        Assert.Equal(1000, first["messages"]![0]!["__meta"]!["timestamp"]!.GetValue<long>());
        var newer = WebUiContinuousHistory.Read(nested, null, 11, 211);
        Assert.Equal(Sequences(older), Sequences(newer));
        var capped = WebUiContinuousHistory.Read(nested, null, 200, 208);
        Assert.Equal(Enumerable.Range(201, 8).Select(x => (long)x), Sequences(capped));
        Assert.False(capped["hasMore"]!.GetValue<bool>());
        Assert.Empty(Sequences(WebUiContinuousHistory.Read(nested, null, 211, 211)));
        Assert.Empty(Sequences(WebUiContinuousHistory.Read(nested, 1, null, 211)));
        Assert.Equal(240, parent.ReadMessages().Count);
    }

    [Fact]
    public async Task Route_resolves_live_alias_and_materializes_archived_image_without_reading_past_current_snapshot()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var owner = await f.Manager.CreateNamedAsync("main", "continuous", null, null);
        var reference = await f.Manager.Images.PutAsync(ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png), "image/png", "old-image");
        var rows = Enumerable.Range(1, 125).Select(i => new JsonObject
        {
            ["role"] = i % 2 == 1 ? "user" : "model",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "route original " + i }),
        }).ToArray();
        rows[19]["parts"]!.AsArray().Add(new JsonObject { ["inlineDataRef"] = reference.DeepClone() });
        await ForkClearLifecycleTests.AppendAsync(owner, rows);
        var row = f.Manager.Catalog.Get(owner.Id)!; row["aliases"] = new JsonArray("continuous-alias"); f.Manager.Catalog.Upsert([row]);
        // An Archive row beyond the ordinary snapshot must not leak into display.
        owner.Archive.WriteMessages([Raw(owner.Id, 126)]);
        var route = "api/sessions/continuous-alias/history/continuous";
        var page = (await f.Admin.GetFromJsonAsync<JsonObject>(route))!;
        Assert.Equal(125, page["latestSeq"]!.GetValue<long>());
        Assert.Equal(Enumerable.Range(26, 100).Select(i => (long)i), Sequences(page));
        var old = (await f.Admin.GetFromJsonAsync<JsonObject>(route + "?beforeSeq=26"))!;
        Assert.Equal(25, old["messages"]!.AsArray().Count);
        var image = old["messages"]![19]!["parts"]![1]!["inlineDataRef"]!;
        Assert.Equal("/blobs/" + reference["blobId"]!.GetValue<string>(), image["apiPath"]!.GetValue<string>());
        Assert.Null(image["data"]);
        foreach (var query in new[] { "beforeSeq=1&afterSeq=2", "beforeSeq=0", "afterSeq=1.5", "beforeSeq=1&beforeSeq=2", "other=1", "afterSeq=9007199254740992" })
            Assert.Equal(HttpStatusCode.BadRequest, (await f.Admin.GetAsync(route + "?" + query)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await f.Admin.GetAsync("api/sessions/missing/history/continuous")).StatusCode);
    }
}
