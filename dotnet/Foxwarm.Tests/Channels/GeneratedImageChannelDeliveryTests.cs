using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

/// <summary>
/// A generated image reaches a channel's file send with its original bytes. File-mode blobs
/// are sent from their file; blobs that aren't local files (the hosted stores in the
/// backend-neutral run) are streamed into the runtime's scratch space and removed after the send.
/// </summary>
[Trait("Backend", "neutral")]
public sealed class GeneratedImageChannelDeliveryTests
{
    [Fact]
    public async Task A_generated_image_is_sent_as_a_file_with_its_original_bytes()
    {
        var jpeg = TelegramChannelTests.Jpeg();
        await using var provider = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: "
                            + new JsonObject
                            {
                                ["type"] = "response.completed",
                                ["response"] = new JsonObject
                                {
                                    ["status"] = "completed",
                                    ["output"] = new JsonArray(
                                        TelegramHostTests.Output("image-answer"),
                                        new JsonObject
                                        {
                                            ["type"] = "image_generation_call",
                                            ["id"] = "generated-fixture",
                                            ["status"] = "completed",
                                            ["output_format"] = "jpeg",
                                            ["result"] = Convert.ToBase64String(jpeg),
                                        }
                                    ),
                                },
                            }.ToJsonString()
                            + "\n\n"
                    )
                )
        );
        await using var f = await ExternalChannelFixture.CreateAsync(provider: provider.BaseUri);
        var sent = new TaskCompletionSource<(ChannelFile File, byte[] Bytes)>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        f.Manager.ChannelRegistry.Register(
            "controlled",
            new RegisteredChannel(
                "controlled",
                (_, _, _, _) => Task.CompletedTask,
                SendFile: async (_, file, _, token) =>
                    sent.TrySetResult((file, await File.ReadAllBytesAsync(file.Path, token)))
            )
        );
        f.Manager.AttachChannel("controlled:42", f.Owner);
        await new SessionRuntime(f.Manager).SubmitAndRunAsync(f.Owner.Id, QueueItem.UserText("draw"));
        await f.Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(20));

        var (delivered, bytes) = await sent.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(delivered.IsImage);
        Assert.Equal("image/jpeg", delivered.MimeType);
        Assert.EndsWith(".jpg", delivered.Name);
        var blob = Convert.ToHexStringLower(SHA256.HashData(bytes)) + ".jpg";
        Assert.True(f.Manager.Images.Exists(blob));
        Assert.Equal(await f.Manager.Images.Blobs.ReadAllAsync(blob, CancellationToken.None), bytes);
        var staging = Path.Combine(f.Manager.DataRoot, ".temp", "image-delivery");
        if (f.Manager.Images.LocalPath(blob) is { } local)
        {
            Assert.False(HostedTestBackend.Active);
            Assert.Equal(local, delivered.Path);
            Assert.False(Directory.Exists(staging));
        }
        else
        {
            Assert.True(HostedTestBackend.Active);
            Assert.StartsWith(staging + Path.DirectorySeparatorChar, delivered.Path);
            // Removed once every channel's send has finished.
            await WaitUntilAsync(() => !File.Exists(delivered.Path));
            Assert.Empty(Directory.EnumerateFileSystemEntries(staging));
        }
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Condition not reached within 5 s.");
            await Task.Delay(20);
        }
    }
}
