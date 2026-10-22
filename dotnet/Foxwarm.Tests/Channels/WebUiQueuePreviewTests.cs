using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiQueuePreviewTests
{
    [Fact]
    public void Channel_system_parts_are_bounded_previews_without_mutating_the_queued_input()
    {
        var state = new SessionState("preview");
        var wrapped = SessionBoundary.ChannelInput(
            [new JsonObject { ["text"] = "queued body " + new string('x', 5000) }],
            "webui"
        );
        var original = wrapped[0].ToJsonString();
        state.Queue.Add(
            new QueueItem(QueueItemType.User, wrapped, ClientMessageId: "browser-input")
        );
        state.Queue.Add(
            QueueItem.Prebuilt(
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["system"] = "prebuilt system",
                            ["text"] = "visible text",
                            ["thinking"] = new string('y', 5000),
                        }
                    ),
                }
            )
        );
        for (var index = 2; index < 21; index++)
            state.Queue.Add(QueueItem.UserText("queued " + index));
        var models = HostModels.Parse(
            new JsonObject { ["providers"] = new JsonObject() },
            new JsonObject()
        );
        var history = WebUiContract.History(
            state.Snapshot(),
            models,
            false,
            false,
            null,
            null,
            null
        );
        var previews = history["queuedMessages"]!.AsArray();
        Assert.Equal(20, previews.Count);
        Assert.Equal(21, history["queueLength"]!.GetValue<int>());
        Assert.Equal(1, history["queuedPreviewOmittedCount"]!.GetValue<int>());
        var preview = previews[0]!["parts"]![0]!["system"]!.GetValue<string>();
        Assert.StartsWith(wrapped[0]["system"]!.GetValue<string>()[..4000], preview);
        Assert.True(preview.Length < 4100);
        Assert.True(previews[0]!["__meta"]!["queuedPreview"]!.GetValue<bool>());
        Assert.Equal("prebuilt system", previews[1]!["parts"]![0]!["system"]!.GetValue<string>());
        Assert.Equal("visible text", previews[1]!["parts"]![0]!["text"]!.GetValue<string>());
        Assert.True(previews[1]!["parts"]![0]!["thinking"]!.GetValue<string>().Length < 4100);
        Assert.Equal(original, wrapped[0].ToJsonString());
        Assert.Equal(original, state.Queue[0].Parts![0].ToJsonString());
        Assert.Empty(state.History);
    }
}
