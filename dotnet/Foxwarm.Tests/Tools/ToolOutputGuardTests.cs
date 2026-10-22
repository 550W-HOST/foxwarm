using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolOutputGuardTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    [InlineData("\"owned-real-error\"")]
    [InlineData("false")]
    [InlineData("0")]
    [InlineData("\"\"")]
    [InlineData("{\"code\":\"failed\"}")]
    public async Task Oversized_results_preserve_null_success_and_non_null_error_classification(
        string? errorJson
    )
    {
        using var temp = new TempDirectory();
        var response = new JsonObject { ["output"] = new string('x', 45000) + "-END" };
        if (errorJson is not null)
            response["error"] = JsonNode.Parse(errorJson);
        var original = response.ToJsonString();
        var isError = response["error"] is not null;

        var guarded = (await ToolOutputGuard.GuardAsync(response, temp.Path, "large"))!.AsObject();

        Assert.Equal(isError, guarded["error"] is not null);
        Assert.Equal(errorJson is not null, guarded.ContainsKey("error"));
        Assert.Equal(!isError, guarded.ContainsKey("output"));
        Assert.True(guarded["outputTruncated"]!.GetValue<bool>());
        Assert.True(ToolResponseFormatting.Format(guarded).Length < 40000);
        Assert.Equal(
            ToolResponseFormatting.Format(response),
            await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
        );
        Assert.Equal(original, response.ToJsonString());
    }
}