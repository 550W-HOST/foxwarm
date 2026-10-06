using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ImageLegacyLifecycleTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string data, string work) =>
        new(data, work, Options, HostModels.ForTest(Options));

    [Fact]
    public async Task Real_legacy_path_without_digest_survives_new_move_fork_parent_deletion_restart_and_transport_clone_with_exact_immutable_audit()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        string authorityPath;
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            authorityPath = owner.AuthorityStore.AuthorityPath;
        }
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var legacyPath = Path.Combine(data, "state", "sessions-blob", "old.images", "picture.png");
        Directory.CreateDirectory(Path.GetDirectoryName(legacyPath)!);
        await File.WriteAllBytesAsync(legacyPath, bytes);
        var legacy = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["inlineDataRef"] = new JsonObject
                    {
                        ["path"] = "state/sessions-blob/old.images/picture.png",
                        ["mimeType"] = "image/png",
                        ["byteLength"] = bytes.Length,
                    },
                }
            ),
            ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1 },
        };
        var document = JsonNode.Parse(await File.ReadAllTextAsync(authorityPath))!.AsObject();
        document["history"] = new JsonArray(legacy.DeepClone());
        document["nextMessageSeq"] = 2;
        document["meta"]!["messageCount"] = 1;
        await File.WriteAllTextAsync(authorityPath, document.ToJsonString());
        var audit = new SqliteArchiveMessageStore(
            Path.Combine(data, "state", "archive-store.sqlite"),
            "old"
        );
        var exact = EcmaJson.Stringify(legacy);
        audit.WriteMessages([
            new ArchiveMessageRecord(
                "old",
                "main",
                1,
                1,
                "user",
                (JsonObject)legacy.DeepClone(),
                exact
            ),
        ]);
        string childId;
        await using (var manager = Manager(data, work))
        {
            await manager.LoadAsync();
            var owner = await manager.RequiredAsync("old");
            Assert.NotNull(
                owner.Entry.Snapshot().History[0]["parts"]![0]!["inlineDataRef"]!["blobId"]
            );
            var fork = await manager.ForkAsync(owner, "fork");
            childId = fork.Id;
            Assert.Equal(1, fork.Archive.ReadBranch()!.MessageCap);
            await manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "current" });
            Assert.Equal(bytes, await File.ReadAllBytesAsync(legacyPath));
            Assert.False(
                Directory.Exists(Path.Combine(data, "state", "sessions-blob", "current.images"))
            );
            Assert.Equal(exact, owner.Archive.ReadMessages().Single().MessageJson);
            Assert.Equal(exact, fork.Archive.ReadEffectiveMessagesRange(1, 1).Single().MessageJson);
            var projected = (JsonObject)
                fork.Archive.ReadEffectiveMessagesRange(1, 1).Single().Message.DeepClone();
            await manager.Images.ExternalizeMessageAsync(projected, false);
            var safe = ImageTransport.Project(projected)!.ToJsonString();
            Assert.Contains("/blobs/", safe);
            Assert.DoesNotContain("picture.png", safe);
            await manager.DeleteAsync(owner.Id);
            Assert.Equal(bytes, await File.ReadAllBytesAsync(legacyPath));
            Assert.Equal(exact, fork.Archive.ReadEffectiveMessagesRange(1, 1).Single().MessageJson);
        }
        await using var restarted = Manager(data, work);
        await restarted.LoadAsync();
        var child = await restarted.RequiredAsync(childId);
        var row = child.Archive.ReadEffectiveMessagesRange(1, 1).Single();
        Assert.Equal(exact, row.MessageJson);
        var clone = (JsonObject)row.Message.DeepClone();
        await restarted.Images.ExternalizeMessageAsync(clone, false);
        Assert.NotNull(clone["parts"]![0]!["inlineDataRef"]!["blobId"]);
        Assert.Equal(exact, row.MessageJson);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(legacyPath));
    }

    [Fact]
    public async Task A_previously_completed_old_move_with_missing_legacy_bytes_is_not_reconstructed_or_replaced()
    {
        using var temp = new TempDirectory();
        var images = new ImageBlobStore(temp.Path);
        var old = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["inlineDataRef"] = new JsonObject
                    {
                        ["path"] = "state/sessions-blob/old.images/missing.png",
                        ["mimeType"] = "image/png",
                    },
                }
            ),
        };
        var exact = old.ToJsonString();
        await images.ExternalizeMessageAsync(old, false);
        Assert.Equal(exact, old.ToJsonString());
        Assert.Contains("inlineDataUnavailable", ImageTransport.Project(old)!.ToJsonString());
        Assert.False(Directory.Exists(images.BlobRoot));
        await Assert.ThrowsAsync<ImageInputException>(() =>
            images.HydrateAsync([old], "responses")
        );
    }
}
