using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Images;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

[Trait("Backend", "neutral")]
public sealed class TenantImageRoutesTests
{
    [Fact]
    public async Task Upload_authority_provider_cache_and_session_crop_share_the_tenants_image_boundary()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        byte[] gif = Convert.FromBase64String(
            "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        );
        var uploads = new WebUiUploadedFiles(f.Manager);
        var directory = Path.Combine(uploads.Root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "actual.gif");
        try
        {
            await File.WriteAllBytesAsync(path, gif);
            Assert.Equal(
                "image/gif",
                await f.Manager.Images.Decoder.IdentifyFileAsync(path, default)
            );
            using var ingress = f.Manager.BeginFileIngress(f.Owner);
            var result = await uploads.PrepareAsync(
                new JsonObject
                {
                    ["uploadedFiles"] = new JsonArray(
                        new JsonObject
                        {
                            ["path"] = path,
                            ["filename"] = "actual.gif",
                            ["mimeType"] = "image/gif",
                        }
                    ),
                },
                f.Owner,
                default
            );
            var image = result.Parts.Single(p => p["inlineDataRef"] is not null);
            var reference = image["inlineDataRef"]!.AsObject();
            Assert.Equal(gif, await f.Owner.AuthorityStore.Images.ReadAsync(reference));
            var message = new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(image.DeepClone()),
            };
            await ForkClearLifecycleTests.AppendAsync(f.Owner, message);
            for (int i = 0; i < 2; i++)
            {
                var hydrated = (
                    await f.Manager.Images.HydrateAsync([message], "responses")
                ).Single();
                Assert.Equal(
                    "image/webp",
                    hydrated["parts"]![0]!["inlineData"]!["mimeType"]!.ToString()
                );
            }
            var crop = await f.Manager.CropImageAsync(
                f.Owner,
                new JsonObject
                {
                    ["id"] = reference["imageId"]!.ToString(),
                    ["x"] = 0,
                    ["y"] = 0,
                    ["width"] = 1,
                    ["height"] = 1,
                },
                default
            );
            Assert.Equal("image/png", crop["mimeType"]!.ToString());
        }
        finally
        {
            Directory.Delete(directory, true);
        }

        // A valid header with trailing bytes: canonical file-mode storage accepts it. Hosted
        // canonical probes must refuse before publication, through either independently built
        // image owner; a fallback to the ordinary Skia probe would succeed here.
        var large = new byte[DecoderProtocol.MaxBytes + 1];
        gif.CopyTo(large, 0);
        foreach (var store in new[] { f.Manager.Images, f.Owner.AuthorityStore.Images })
        {
            if (HostedTestBackend.Active)
            {
                var error = await Assert.ThrowsAsync<ImageProcessingException>(() =>
                    store.PutAsync(large, "image/gif", "large")
                );
                Assert.Equal(DecoderProtocol.Failed, error.Message);
            }
            else
            {
                var reference = await store.PutAsync(large, "image/gif", "large");
                Assert.Equal(large.Length, reference["byteLength"]!.GetValue<int>());
            }
        }
    }
}
