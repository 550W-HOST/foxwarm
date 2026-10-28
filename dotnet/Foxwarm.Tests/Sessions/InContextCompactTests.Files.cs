using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class InContextCompactTests
{
    private static JsonObject Submit(string id, JsonObject args, bool unified) => unified
        ? Call(id, "call_tool", new JsonObject { ["toolId"] = "builtin:submit_compact_plan", ["args"] = args })
        : Call(id, "submit_compact_plan", args);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task File_first_foreground_submission_uses_current_cwd_and_commits(bool unified)
    {
        await using var f = await Fixture.CreateAsync(2, async (f, index, request) =>
        {
            if (index > 0)
            {
                Assert.Contains("Selected work is complete.", request.ToJsonString());
                Assert.DoesNotContain("Completed middle detail.", request.ToJsonString());
                return Final();
            }
            await File.WriteAllTextAsync(Path.Combine(f.Work, "input.json"), Plan().ToJsonString());
            return new JsonArray(Submit("plan", new JsonObject { ["inContext"] = true, ["argsFilePath"] = "input.json" }, unified));
        });
        await f.Owner.UpdateCwdAsync(f.Work);
        await f.RunAsync();
        Assert.True(f.ToolResponse("plan")["response"]!["accepted"]!.GetValue<bool>());
        Assert.Equal(1, f.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Single(f.Owner.Archive.ReadBlocks());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Rejected_arguments_are_editable_without_regeneration_and_file_resubmit_commits(bool unified, bool malformed)
    {
        string? path = null;
        string? original = null;
        await using var f = await Fixture.CreateAsync(4, async (f, index, request) =>
        {
            if (index == 0)
            {
                var invalid = Plan();
                invalid["replaceAsBlocks"]![0]!["sourceEnd"] = 9999;
                invalid["replaceAsBlocks"]![0]!["summary"] = "Selected work is complete. " + new string('x', 16000) + " keep the tail";
                original = invalid.ToJsonString();
                if (malformed)
                {
                    original = original[..^1];
                    return unified
                        ? new JsonArray(Call("bad", "call_tool", new JsonObject { ["toolId"] = "builtin:submit_compact_plan", ["argsJson"] = original }))
                        : new JsonArray(new JsonObject { ["type"] = "function_call", ["call_id"] = "bad", ["name"] = "submit_compact_plan", ["arguments"] = original });
                }
                return new JsonArray(Submit("bad", invalid, unified));
            }
            if (index == 1)
            {
                var rejected = f.ToolResponse("bad")["response"]!;
                Assert.Equal("compact_plan_invalid", SessionWait.Text(rejected["error"]?["type"]));
                var error = SessionWait.Text(rejected["error"]?["message"])!;
                Assert.Contains(malformed ? "BytePositionInLine" : "replaceAsBlocks[0]", error);
                path = rejected["argsFilePath"]!.GetValue<string>();
                var saved = await File.ReadAllTextAsync(path);
                if (unified && !malformed)
                    Assert.True(JsonNode.DeepEquals(JsonNode.Parse(original!), JsonNode.Parse(saved)));
                else
                    Assert.Equal(original, saved);
                original = saved;
                Assert.Equal(0, f.Owner.Entry.Snapshot().HistoryVersion);
                Assert.False(f.Owner.Compactor.Active);
                var repairs = new JsonArray(Call("repair", "edit", new JsonObject { ["filePath"] = path, ["oldText"] = "9999", ["newText"] = "2" }));
                if (malformed)
                    repairs.Add(Call("close-json", "edit", new JsonObject { ["filePath"] = path, ["oldText"] = "keep the tail\"}]", ["newText"] = "keep the tail\"}]}" }));
                return repairs;
            }
            if (index == 2)
            {
                Assert.Null(f.ToolResponse("repair")["response"]!["error"]);
                return new JsonArray(Submit("plan", new JsonObject { ["inContext"] = true, ["argsFilePath"] = path }, unified));
            }
            Assert.Contains("Selected work is complete.", request.ToJsonString());
            Assert.DoesNotContain("Completed middle detail.", request.ToJsonString());
            return Final();
        });
        var before = f.Owner.Archive.ReadMessages().Select(row => row.MessageJson).ToArray();
        await f.RunAsync();
        Assert.Equal(1, f.Owner.Entry.Snapshot().HistoryVersion);
        Assert.True(f.ToolResponse("plan")["response"]!["accepted"]!.GetValue<bool>());
        Assert.Equal(before, f.Owner.Archive.ReadMessages().Take(3).Select(row => row.MessageJson));
        Assert.Single(f.Owner.Archive.ReadBlocks());
    }

    [Fact]
    public async Task Malformed_file_is_retained_in_place_and_reports_parser_location()
    {
        var content = "{\n\"replaceAsBlocks\": [";
        await using var f = await Fixture.CreateAsync(2, async (f, index, _) =>
        {
            if (index > 0) return Final();
            await File.WriteAllTextAsync(Path.Combine(f.Work, "broken.json"), content);
            return new JsonArray(Submit("bad", new JsonObject { ["inContext"] = true, ["argsFilePath"] = Path.Combine(f.Work, "broken.json") }, false));
        });
        await f.RunAsync();
        var result = f.ToolResponse("bad")["response"]!;
        Assert.Contains("LineNumber", result["error"]!["message"]!.GetValue<string>());
        Assert.Equal(Path.Combine(f.Work, "broken.json"), result["argsFilePath"]!.GetValue<string>());
        Assert.Equal(content, await File.ReadAllTextAsync(Path.Combine(f.Work, "broken.json")));
        Assert.Equal(0, f.Owner.Entry.Snapshot().HistoryVersion);
    }

    [Fact]
    public async Task File_denial_cancellation_and_staging_failure_do_not_claim_a_saved_plan()
    {
        await using var f = await Fixture.CreateAsync(2, (f, index, _) =>
        {
            if (index > 0) return Task.FromResult(Final());
            var canceled = Plan(9999); canceled["__cancelTool"] = true;
            return Task.FromResult(new JsonArray(
                Submit("denied", new JsonObject { ["inContext"] = true, ["argsFilePath"] = Path.Combine(f.Work, "denied.json") }, false),
                Submit("canceled", canceled, false),
                Submit("invalid", Plan(9999), false)));
        });
        await File.WriteAllTextAsync(Path.Combine(f.Data, "state", "tool-authorization.yaml"), "version: 1\nrules: [{id: deny-files, action: deny, match: {tool: {source: node, name: [read, write]}}}]\n");
        f.Manager.Authorization.Invalidate();
        await f.RunAsync();
        var denied = f.ToolResponse("denied")["response"]!;
        Assert.Equal("tool_authorization_denied", SessionWait.Text(denied["error"]?["type"]));
        Assert.Null(denied["argsFilePath"]);
        Assert.True(f.ToolResponse("canceled")["response"]!["canceled"]!.GetValue<bool>());
        var invalid = f.ToolResponse("invalid")["response"]!;
        Assert.Equal("compact_plan_invalid", SessionWait.Text(invalid["error"]?["type"]));
        Assert.Contains("sourceStart", SessionWait.Text(invalid["error"]?["message"]));
        Assert.NotNull(invalid["stagingError"]);
        Assert.Null(invalid["argsFilePath"]);
        Assert.Equal(0, f.Owner.Entry.Snapshot().HistoryVersion);
    }
    [Fact]
    public async Task File_plan_is_revalidated_against_active_sources_after_an_earlier_commit()
    {
        await using var f = await Fixture.CreateAsync(3, async (f, index, _) =>
        {
            if (index == 2) return Final();
            if (index == 0)
            {
                await File.WriteAllTextAsync(Path.Combine(f.Work, "plan.json"), Plan().ToJsonString());
                return new JsonArray(Submit("first", Plan(), false));
            }
            Assert.Equal(1, f.Owner.Entry.Snapshot().HistoryVersion);
            return new JsonArray(Submit("stale", new JsonObject { ["inContext"] = true, ["argsFilePath"] = Path.Combine(f.Work, "plan.json") }, true));
        });
        await f.RunAsync();
        var stale = f.ToolResponse("stale")["response"]!;
        Assert.Equal("compact_plan_invalid", SessionWait.Text(stale["error"]?["type"]));
        Assert.Contains("sourceStart", SessionWait.Text(stale["error"]?["message"]));
        Assert.NotNull(stale["argsFilePath"]);
        Assert.Equal(1, f.Owner.Entry.Snapshot().HistoryVersion);
        Assert.Single(f.Owner.Archive.ReadBlocks());
    }

}
