using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class HostedImageEvidenceTests
{
    [Fact]
    public async Task Failed_hosted_call_retains_evidence_without_a_blob_store()
    {
        var output = new JsonArray(
            new JsonObject
            {
                ["type"] = "image_generation_call",
                ["id"] = "failed_without_storage",
                ["status"] = "failed",
                ["error"] = new JsonObject
                {
                    ["code"] = "system_error",
                    ["message"] = "Synthetic failure",
                },
            }
        );
        var normalized = await HostedResponsesTools.ExternalizeAsync(output, null, "a/m", default);
        Assert.Empty(normalized.Parts);
        var failure = Assert.Single(normalized.FailureParts).Value;
        Assert.Contains("system_error", failure.ToJsonString());
        Assert.Equal(0, normalized.SuccessfulCount);
    }

    [Fact]
    public void Failure_summary_is_bounded_allowlisted_and_idempotent()
    {
        var item = new JsonObject
        {
            ["type"] = "image_generation_call",
            ["id"] = "image_test",
            ["status"] = "failed",
            ["prompt"] = "private prompt",
            ["result"] = new string('A', 1000),
            ["error"] = new JsonObject
            {
                ["type"] = "UserError",
                ["code"] = "system_error",
                ["message"] = "Synthetic failure private prompt " + new string('B', 200),
                ["prompt"] = "private prompt",
                ["b64_json"] = new string('C', 1000),
            },
        };
        var summary = HostedImageEvidence.Summary(item, "resp_test");
        Assert.DoesNotContain("private prompt", summary.ToJsonString());
        Assert.DoesNotContain(new string('A', 80), summary.ToJsonString());
        Assert.DoesNotContain(new string('B', 80), summary.ToJsonString());
        Assert.DoesNotContain(new string('C', 80), summary.ToJsonString());
        Assert.True(summary["hasResult"]!.GetValue<bool>());
        Assert.Equal(summary.ToJsonString(), HostedImageEvidence.Summary(summary).ToJsonString());
        item["id"] = new string('x', 10000);
        item["error"]!["type"] = new string('t', 10000);
        item["error"]!["message"] = new string('z', 100000);
        var bounded = HostedImageEvidence.Summary(item, new string('r', 10000));
        Assert.True(bounded.ToJsonString().Length < 1000);
        Assert.Contains("oversized error message omitted", bounded.ToJsonString());
        item["error"]!["message"] = "upstream body: {\"prompt\":\"unknown private prompt\"}";
        Assert.DoesNotContain(
            "unknown private prompt",
            HostedImageEvidence.Summary(item).ToJsonString()
        );
    }

    [Fact]
    public async Task Omitted_raw_stream_keeps_bounded_credential_safe_image_errors_before_terminal_response()
    {
        using var temp = new TempDirectory();
        const string secret = "fixture-private-provider-key";
        var uri = new Uri("http://unused.invalid");
        var model = HostModels
            .Parse(
                new JsonObject
                {
                    ["default"] = "a/m",
                    ["providers"] = new JsonObject
                    {
                        ["a"] = new JsonObject
                        {
                            ["providerType"] = "openai-responses",
                            ["baseUrl"] = uri.ToString(),
                            ["models"] = new JsonArray("m"),
                            ["imageGeneration"] = new JsonObject { ["enabled"] = true },
                        },
                    },
                },
                new JsonObject()
            )
            .Resolve("a/m");
        var options = new ResponsesClientOptions(uri, "m", "a/m", secret, "", 1000);
        var attempt = new ModelInteractionDiagnostics(temp.Path)
            .Begin()
            .StartAttempt(model, options, 1);
        await attempt.PreparedAsync(new JsonObject());
        attempt.Block(
            new JsonObject
            {
                ["type"] = "response.created",
                ["response"] = new JsonObject { ["id"] = "resp_interrupted" },
            }.ToJsonString()
        );
        for (var index = 0; index < HostedImageEvidence.MaxCalls + 5; index++)
            attempt.Block(
                ResponsesPrefixCommitTests
                    .Done(
                        index,
                        new JsonObject
                        {
                            ["type"] = "image_generation_call",
                            ["id"] = "image_" + index,
                            ["status"] = "failed",
                            ["revised_prompt"] = "private image description",
                            ["result"] = new string('A', 1000),
                            ["error"] = new JsonObject
                            {
                                ["code"] = "system_error",
                                ["message"] = "Synthetic failure " + secret,
                                ["prompt"] = "private image description",
                            },
                        }
                    )
                    .ToJsonString()
            );
        // Sparse later events must not erase the earlier error details.
        attempt.Block(
            ResponsesPrefixCommitTests
                .Done(
                    0,
                    new JsonObject
                    {
                        ["type"] = "image_generation_call",
                        ["id"] = "image_0",
                        ["status"] = "in_progress",
                    }
                )
                .ToJsonString()
        );
        // No completed response/body is required to preserve the upstream tool evidence.
        await attempt.FinishedAsync(new OperationCanceledException("fixture stop"));
        var path = Assert.Single(
            Directory.GetFiles(Path.Combine(temp.Path, "state", "logs", "recent"), "*_res.json")
        );
        var json = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
        var raw = json["attempts"]![0]!["rawStream"]!;
        Assert.True(raw["contentOmitted"]!.GetValue<bool>());
        Assert.True(raw["imageGenerationCallsTruncated"]!.GetValue<bool>());
        Assert.Equal(HostedImageEvidence.MaxCalls, raw["imageGenerationCalls"]!.AsArray().Count);
        Assert.Equal(
            "resp_interrupted",
            raw["imageGenerationCalls"]![0]!["responseId"]!.GetValue<string>()
        );
        Assert.Equal(
            "system_error",
            raw["imageGenerationCalls"]![0]!["error"]!["code"]!.GetValue<string>()
        );
        Assert.Equal("failed", raw["imageGenerationCalls"]![0]!["status"]!.GetValue<string>());
        Assert.DoesNotContain(secret, json.ToJsonString());
        Assert.DoesNotContain("private image description", json.ToJsonString());
        Assert.DoesNotContain(new string('A', 80), json.ToJsonString());
        Assert.True(raw.ToJsonString().Length < 24000);
    }

    [Theory]
    [InlineData("failed")]
    [InlineData("incomplete")]
    public void Terminal_image_status_does_not_regress_on_late_activity(string status)
    {
        var progress = new List<ResponsesStreamProgress>();
        var accumulator = new ResponsesEventAccumulator(
            new ResponsesStreamCallbacks { OnProgress = progress.Add }
        );
        accumulator.Consume(
            ResponsesPrefixCommitTests.Done(
                0,
                new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "image_status",
                    ["status"] = status,
                }
            )
        );
        accumulator.Consume(
            new JsonObject
            {
                ["type"] = "response.image_generation_call.generating",
                ["output_index"] = 0,
            }
        );
        Assert.All(
            progress.SelectMany(value => value.Parts),
            part => Assert.Equal(status, part.Status)
        );
    }
}
