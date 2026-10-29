using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolOutputGuardTests
{
    private static Task<JsonNode?> Guard(JsonNode? response, string workspace) =>
        ToolOutputGuard.GuardAsync(
            response,
            text => ToolOutputGuard.SaveLocalAsync(text, workspace)
        );

    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    [InlineData("\"owned-real-error\"")]
    [InlineData("false")]
    [InlineData("0")]
    [InlineData("\"\"")]
    [InlineData("{\"code\":\"failed\"}")]
    public async Task Output_stage_retains_structured_siblings_and_original_error_values(
        string? errorJson
    )
    {
        using var temp = new TempDirectory();
        var output = new string('x', 50_000) + "-END";
        var response = new JsonObject
        {
            ["output"] = output,
            ["resultId"] = "ordinary-sibling",
            ["details"] = new JsonObject { ["accepted"] = true },
        };
        if (errorJson is not null)
            response["error"] = JsonNode.Parse(errorJson);
        var original = response.ToJsonString();

        var guarded = (await Guard(response, temp.Path))!.AsObject();

        Assert.Equal(errorJson is not null, guarded.ContainsKey("error"));
        Assert.True(JsonNode.DeepEquals(response["error"], guarded["error"]));
        Assert.Equal("ordinary-sibling", guarded["resultId"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(response["details"], guarded["details"]));
        Assert.True(guarded["outputTruncated"]!.GetValue<bool>());
        Assert.True(ToolResponseFormatting.Format(guarded).Length <= 40_000);
        Assert.Equal(
            output,
            await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
        );
        Assert.Equal(original, response.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Whole_response_stage_saves_original_envelope_with_or_without_an_output_stage(
        bool largeOutput
    )
    {
        using var temp = new TempDirectory();
        var response = new JsonObject
        {
            ["output"] = largeOutput ? new string('x', 50_000) : "small output",
            ["data"] = new JsonArray(new JsonObject { ["value"] = new string('y', 50_000) }),
            ["runId"] = "retained-run",
            ["resultId"] = "not-in-summary",
            ["error"] = null,
        };
        var original = ToolResponseFormatting.Format(response);
        var guarded = (await Guard(response, temp.Path))!.AsObject();
        Assert.Null(guarded["error"]);
        Assert.True(guarded.ContainsKey("error"));
        Assert.Null(guarded["data"]);
        Assert.Null(guarded["resultId"]);
        Assert.Equal("retained-run", guarded["runId"]!.GetValue<string>());
        Assert.True(ToolResponseFormatting.Format(guarded).Length <= 40_000);
        Assert.Equal(
            original,
            await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
        );
        var files = Directory.GetFiles(Path.Combine(temp.Path, ".temp", "tool-output"));
        Assert.Equal(largeOutput ? 2 : 1, files.Length);
        if (largeOutput)
            Assert.Contains(
                files,
                file => File.ReadAllText(file) == response["output"]!.GetValue<string>()
            );
    }

    [Fact]
    public async Task Structured_output_field_is_saved_as_a_value_without_unwrapping_its_own_output_key()
    {
        using var temp = new TempDirectory();
        var value = new JsonObject { ["output"] = new string('x', 50_000) };
        var guarded = (await Guard(new JsonObject { ["output"] = value.DeepClone() }, temp.Path))!;
        Assert.Equal(
            ToolResponseFormatting.FormatStructuredValue(value),
            await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
        );
    }

    [Theory]
    [InlineData("null")]
    [InlineData("false")]
    [InlineData("0")]
    [InlineData("\"\"")]
    [InlineData("{\"message\":\"failure\"}")]
    public async Task Summary_and_save_failure_preserve_success_error_classification(
        string errorJson
    )
    {
        using var temp = new TempDirectory();
        var response = new JsonObject
        {
            ["data"] = new string('x', 50_000),
            ["error"] = JsonNode.Parse(errorJson),
        };
        foreach (var failSave in new[] { false, true })
        {
            var guarded = (
                await ToolOutputGuard.GuardAsync(
                    response,
                    text =>
                        failSave
                            ? Task.FromException<ToolOutputGuard.SavedOutput>(
                                new IOException("owned save failure")
                            )
                            : ToolOutputGuard.SaveLocalAsync(text, temp.Path)
                )
            )!;
            Assert.Equal(response["error"] is not null, guarded["error"] is not null);
            Assert.Equal(response["error"] is null, guarded.AsObject().ContainsKey("output"));
            Assert.True(ToolResponseFormatting.Format(guarded).Length <= 40_000);
            Assert.Equal(failSave, guarded["toolOutputGuardError"] is not null);
            if (failSave)
                Assert.Null(guarded["outputFullPath"]);
        }
    }

    [Fact]
    public async Task Failed_second_save_does_not_advertise_first_stage_file_as_the_complete_response()
    {
        using var temp = new TempDirectory();
        var response = new JsonObject
        {
            ["output"] = new string('x', 50_000),
            ["data"] = new string('y', 50_000),
        };
        var saves = 0;
        var guarded = (
            await ToolOutputGuard.GuardAsync(
                response,
                text =>
                    ++saves == 1
                        ? ToolOutputGuard.SaveLocalAsync(text, temp.Path)
                        : Task.FromException<ToolOutputGuard.SavedOutput>(
                            new IOException("second save failed")
                        )
            )
        )!;
        Assert.Equal(2, saves);
        Assert.Null(guarded["error"]);
        Assert.Null(guarded["outputFullPath"]);
        Assert.NotNull(guarded["toolOutputGuardError"]);
        Assert.Contains("second save failed", guarded["output"]!.GetValue<string>());
    }

    [Fact]
    public async Task Image_carriers_are_unchanged_and_excluded_from_saved_text()
    {
        using var temp = new TempDirectory();
        var image = new JsonObject
        {
            ["mimeType"] = "image/png",
            ["data"] = new string('A', 60_000),
        };
        var response = new JsonObject
        {
            ["output"] = new string('x', 50_000),
            ["inlineData"] = image.DeepClone(),
            ["inlineDataItems"] = new JsonArray(
                image.DeepClone(),
                new JsonObject { ["mimeType"] = "audio/wav", ["data"] = "audio-data" }
            ),
        };
        var before = response.ToJsonString();
        var guarded = (await Guard(response, temp.Path))!;
        Assert.True(JsonNode.DeepEquals(image, guarded["inlineData"]));
        Assert.Contains(
            guarded["inlineDataItems"]!.AsArray(),
            item => JsonNode.DeepEquals(image, item)
        );
        Assert.Contains(
            guarded["inlineDataItems"]!.AsArray(),
            item => item?["data"]?.GetValue<string>() == "audio-data"
        );
        Assert.Equal(
            response["output"]!.GetValue<string>(),
            await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
        );
        Assert.Equal(before, response.ToJsonString());
    }

    [Fact]
    public async Task Large_arrays_scalars_and_errors_save_their_complete_original_presentation()
    {
        using var temp = new TempDirectory();
        foreach (
            var response in new JsonNode[]
            {
                JsonValue.Create(new string('x', 50_000))!,
                new JsonArray(new JsonObject { ["value"] = new string('x', 50_000) }),
                new JsonObject { ["error"] = new string('e', 50_000) },
            }
        )
        {
            var guarded = (await Guard(response, temp.Path))!;
            Assert.Equal(response is JsonObject, guarded["error"] is not null);
            Assert.True(ToolResponseFormatting.Format(guarded).Length <= 40_000);
            Assert.Equal(
                ToolResponseFormatting.Format(response),
                await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
            );
        }
    }

    [Fact]
    public async Task Small_values_and_exact_threshold_output_are_unchanged_without_saving()
    {
        foreach (
            var value in new JsonNode?[]
            {
                null,
                JsonValue.Create(false),
                new JsonArray(1, 2),
                new JsonObject { ["output"] = new string('x', 40_000) },
            }
        )
            Assert.Same(
                value,
                await ToolOutputGuard.GuardAsync(
                    value,
                    _ => throw new InvalidOperationException("must not save")
                )
            );
    }
}
