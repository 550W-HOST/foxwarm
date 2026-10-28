using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class SessionQueuedContentTests
{
    internal static async Task<string> SeedMalformed(
        string root,
        string id,
        bool wrapped,
        bool withImage = false
    )
    {
        await SessionUpgradeCompatibilityTests.Seed(root, id, required: true);
        var file = Path.Combine(root, "state", "sessions", id + ".json");
        var value = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        var parts = new JsonArray();
        if (withImage)
            parts.Add(
                new JsonObject
                {
                    ["inlineData"] = new JsonObject
                    {
                        ["mimeType"] = "image/png",
                        ["data"] = Convert.ToBase64String(
                            ImageCodecTests.Raster(SKEncodedImageFormat.Png)
                        ),
                    },
                }
            );
        parts.Add(new JsonObject { ["functionResponse"] = "malformed-tool-shape" });
        var item = new JsonObject { ["type"] = "background" };
        if (wrapped)
            item["message"] = new JsonObject { ["role"] = "tool", ["parts"] = parts };
        else
            item["parts"] = parts;
        value["queue"] = new JsonArray(item);
        var original = value.ToJsonString();
        await File.WriteAllTextAsync(file, original);
        return original;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Malformed_queued_content_is_local_before_image_publication_and_normal_admission_retries_after_repair(
        bool wrapped
    )
    {
        using var temp = new TempDirectory();
        await SessionUpgradeCompatibilityTests.Seed(temp.Path, "healthy", required: true);
        var original = await SeedMalformed(temp.Path, "broken", wrapped, withImage: true);
        var file = Path.Combine(temp.Path, "state", "sessions", "broken.json");
        var blobRoot = Path.Combine(temp.Path, "state", "image-blobs");
        var field = wrapped
            ? "queue[0].message.parts[1].functionResponse"
            : "queue[0].parts[1].functionResponse";
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.True(report.CanSelect);
        var issue = Assert.Single(report.Issues);
        Assert.False(issue.Blocking);
        Assert.Equal("Session unavailable", issue.Category);
        Assert.Contains(field, issue.Detail);
        Assert.DoesNotContain("malformed-tool-shape", issue.Detail);
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.False(Directory.Exists(blobRoot));

        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        Assert.Equal("healthy", Assert.Single(manager.Owners()).Id);
        Assert.Null(manager.Find("broken"));
        var failure = await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() =>
            manager.RequiredAsync("broken")
        );
        var diagnostic = MainLog.SafeFailure(failure);
        Assert.Contains(field, diagnostic);
        Assert.DoesNotContain("malformed-tool-shape", diagnostic);
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        Assert.False(Directory.Exists(blobRoot));

        // Repair only the damaged persisted part. A metadata-free queued message
        // and scalar tool response remain valid; ordinary admission materializes images.
        var repaired = JsonNode.Parse(original)!.AsObject();
        var item = repaired["queue"]![0]!;
        var parts = (wrapped ? item["message"]!["parts"] : item["parts"])!.AsArray();
        parts[1]!["functionResponse"] = new JsonObject
        {
            ["tool_use_id"] = "historical-read",
            ["name"] = "read",
            ["response"] = "retained scalar result",
        };
        await File.WriteAllTextAsync(file, repaired.ToJsonString());
        var owner = await manager.RequiredAsync("broken");
        Assert.Same(owner, manager.Find("broken"));
        Assert.Single(owner.Entry.Snapshot().Queue);
        Assert.Empty(owner.Entry.Snapshot().History);
        Assert.True(Directory.Exists(blobRoot));
        Assert.Equal(repaired.ToJsonString(), await File.ReadAllTextAsync(file));
    }
}
