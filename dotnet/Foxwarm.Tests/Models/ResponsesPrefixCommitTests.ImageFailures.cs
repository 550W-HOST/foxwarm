using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed partial class ResponsesPrefixCommitTests
{
    [Theory]
    [InlineData(false, "failed", false)]
    [InlineData(true, "failed", false)]
    [InlineData(false, "incomplete", false)]
    [InlineData(true, "incomplete", false)]
    [InlineData(false, "completed", false)]
    [InlineData(true, "completed", false)]
    [InlineData(false, "failed", true)]
    [InlineData(true, "failed", true)]
    public async Task Image_failure_with_text_is_durable_bounded_evidence_without_retry(
        bool websocket,
        string imageStatus,
        bool successfulImage
    )
    {
        const string token = "fixture-image-provider-secret";
        const string header = "fixture-image-header-secret";
        const string prompt = "private image prompt must not be retained";
        const string png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        var progress = new List<ResponsesStreamProgress>();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number > 1)
                {
                    Assert.Null(context.Request["previous_response_id"]);
                    Assert.Contains(
                        "image generation did not produce a usable image",
                        context.Request.ToJsonString()
                    );
                    Assert.DoesNotContain(
                        context.Request["input"]!.AsArray(),
                        item =>
                            item?["type"]?.GetValue<string>() == "image_generation_call"
                            && item?["id"]?.GetValue<string>() == "image_failed"
                    );
                    await context.Send(Completed(Commentary("next answer", "final_answer")));
                    return;
                }
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.created",
                        ["response"] = new JsonObject { ["id"] = "resp_image_failure" },
                    }
                );
                var items = new List<JsonObject> { Commentary("Drawing now") };
                await context.Send(Done(0, (JsonObject)items[0].DeepClone()));
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.output_item.added",
                        ["output_index"] = 1,
                        ["item"] = new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "image_failed",
                            ["status"] = "in_progress",
                        },
                    }
                );
                items.Add(
                    new JsonObject
                    {
                        ["type"] = "image_generation_call",
                        ["id"] = "image_failed",
                        ["status"] = imageStatus,
                        ["result"] = imageStatus == "completed" ? "invalid-base64!" : null,
                        ["revised_prompt"] = prompt,
                        ["error"] = new JsonObject
                        {
                            ["code"] = "system_error",
                            ["type"] = "UserError",
                            ["message"] =
                                $"Synthetic failure {token} {header} {prompt} data:image/png;base64,{png}",
                            ["prompt"] = prompt,
                            ["partial_image_b64"] = png,
                            ["opaque"] = new JsonObject { ["prompt"] = prompt },
                        },
                    }
                );
                if (successfulImage)
                    items.Add(
                        new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "image_good",
                            ["status"] = "completed",
                            ["output_format"] = "png",
                            ["result"] = png,
                        }
                    );
                items.Add(Commentary("A normal final answer still survives", "final_answer"));
                for (var index = 1; index < items.Count; index++)
                    await context.Send(Done(index, (JsonObject)items[index].DeepClone()));
                var completion = Completed(items.ToArray());
                completion["response"]!["id"] = "resp_image_failure";
                await context.Send(completion);
            }
        );
        await using var owner = new Owner(
            peer.Uri,
            websocket,
            generated: true,
            diagnostics: true,
            observed: value => progress.Add(value),
            providerFields: new JsonObject
            {
                ["apiKey"] = token,
                ["extraHeaders"] = new JsonObject { ["X-Fixture-Secret"] = header },
            }
        );
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Single(peer.Requests); // No regeneration/retry for a hosted failure alongside usable text.
        var rows = (await owner.Store.LoadAsync("s"))!.History.Materialize().ToArray();
        var parts = rows.SelectMany(row => row["parts"]!.AsArray()).ToArray();
        var failure = Assert.Single(
            parts,
            part => part?["providerMeta"]?["openaiResponses"]?["imageGenerationFailure"] is not null
        )!;
        var evidence = failure["providerMeta"]!["openaiResponses"]!["imageGenerationFailure"]!;
        Assert.Equal(imageStatus, evidence["status"]!.GetValue<string>());
        Assert.Equal("resp_image_failure", evidence["responseId"]!.GetValue<string>());
        Assert.Equal("image_failed", evidence["id"]!.GetValue<string>());
        Assert.Equal("UserError", evidence["error"]!["type"]!.GetValue<string>());
        Assert.Equal("system_error", evidence["error"]!["code"]!.GetValue<string>());
        Assert.Contains(
            "image generation did not produce a usable image",
            failure["text"]!.GetValue<string>()
        );
        Assert.Contains(
            "A normal final answer still survives",
            string.Concat(rows.Select(row => row.ToJsonString()))
        );
        Assert.Equal(
            successfulImage ? 1 : 0,
            parts.Count(part => part?["inlineDataRef"] is not null)
        );
        Assert.Contains(
            progress.SelectMany(value => value.Parts),
            part => part.Kind == "image-generation" && part.Status == imageStatus
        );

        var journal = Assert.Single(await owner.Journal.ListAsync("s", null, null, null, 10));
        var restored = await owner.Journal.ReconstructAsync(
            journal!["requestId"]!.GetValue<string>()
        );
        Assert.Contains("imageGenerationFailure", restored.ToJsonString());
        Assert.Contains("\"outcome\":\"success\"", restored.ToJsonString());
        var raw = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(owner.RecentLogs, "*_res.json"))
            )
        )!;
        var calls = raw["rawStream"]!["imageGenerationCalls"]!.AsArray();
        var diagnostic = Assert.Single(
            calls,
            call => call?["id"]?.GetValue<string>() == "image_failed"
        )!;
        Assert.Equal("UserError", diagnostic["error"]!["type"]!.GetValue<string>());
        Assert.Equal("resp_image_failure", diagnostic["responseId"]!.GetValue<string>());
        Assert.True(raw["rawStream"]!["contentOmitted"]!.GetValue<bool>());
        Assert.Null(raw["rawStream"]!["body"]);
        var retained =
            string.Concat(rows.Select(row => row.ToJsonString()))
            + restored.ToJsonString()
            + raw.ToJsonString();
        foreach (var sensitive in new[] { token, header, prompt, png })
            Assert.DoesNotContain(sensitive, retained);
        Assert.True(evidence.ToJsonString().Length < 2000);

        await owner.Run("continue");
        Assert.Equal(2, peer.Requests.Count);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
    }
}
