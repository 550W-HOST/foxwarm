using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    private static JsonObject Call(string tool, JsonObject? args = null) => new() { ["args"] = new JsonObject { ["toolId"] = "builtin:" + tool, ["args"] = args ?? new JsonObject() } };
    private static JsonObject NodeCall(string tool, JsonObject args) => new() { ["args"] = new JsonObject { ["toolId"] = "node:master/" + tool, ["args"] = args } };

    [Fact]
    public async Task Process_to_real_MCP_registry_effect_commits_once_and_resumes_without_Foxwarm_model_or_cost()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var output = Path.Combine(f.Main.Manager.AgentDirectory("main"), "effect.txt");
        await f.PeerAsync(new JsonObject
        {
            ["calls"] = new JsonArray(NodeCall("write", new JsonObject { ["filePath"] = output, ["content"] = "one effect" })),
            ["compact"] = true, ["late"] = true,
        });
        await f.RunAsync("first input");
        Assert.True(f.Owner.Entry.LastBackgroundProcessorFailure is null, f.Owner.Entry.LastBackgroundProcessorFailure + (File.Exists(Path.Combine(f.Cwd, "peer-error.txt")) ? File.ReadAllText(Path.Combine(f.Cwd, "peer-error.txt")) : ""));
        Assert.Equal("one effect", await File.ReadAllTextAsync(output));
        var snapshot = f.Owner.Entry.Snapshot();
        var checkpoint = snapshot.AuthorityEnvelope["externalRuntime"]!.AsObject();
        Assert.Equal("complete", checkpoint["status"]!.GetValue<string>());
        Assert.Equal("cli-configured-model", checkpoint["model"]!.GetValue<string>());
        Assert.Equal(1.25, checkpoint["lastResult"]!["total_cost_usd"]!.GetValue<double>());
        Assert.Equal(11, checkpoint["lastResult"]!["usage"]!["input_tokens"]!.GetValue<int>());
        Assert.Null(snapshot.AuthorityEnvelope["model"]);
        Assert.Null(snapshot.AuthorityEnvelope["stats"]?["totalCost"]);
        Assert.Equal(0, SessionWait.Number(snapshot.AuthorityEnvelope["stats"]?["totalInputTokens"]) ?? 0);
        Assert.Equal(0, snapshot.HistoryVersion);
        var history = snapshot.History.Materialize();
        Assert.Single(history, row => row["parts"]!.AsArray().Any(p => p?["functionCall"] is not null));
        Assert.Single(history, row => row["role"]!.GetValue<string>() == "tool");
        Assert.Single(history, row => row["parts"]!.AsArray().Any(p => SessionWait.Text(p?["text"]) == "Hello 🦊"));
        Assert.DoesNotContain(history, row => row["parts"]!.AsArray().Any(p => SessionWait.Text(p?["text"]) is "late" or "duplicate"));
        Assert.Contains(history, row => SessionWait.Text(row["__meta"]?["runtimeObservation"]) == "compaction");
        Assert.All(history, row => Assert.Null(row["__meta"]?["llmRequestId"]));
        var first = f.Lines("inputs.jsonl")[0];
        Assert.Contains("Owned runtime instruction.", first["prompt"]!.GetValue<string>());
        Assert.DoesNotContain("foxwarm-current-model", first["prompt"]!.GetValue<string>());
        var arguments = first["args"]!.AsArray().Select(SessionWait.Text).ToArray();
        foreach (var forbidden in new[] { "--model", "--bare", "--dangerously-skip-permissions", "--continue" }) Assert.DoesNotContain(forbidden, arguments);
        Assert.Contains("--strict-mcp-config", arguments);
        Assert.True(first["overlay"]!["disableAllHooks"]!.GetValue<bool>());
        Assert.Null(first["overlay"]!["model"]);
        await AssertRevokedAsync(f, first["token"]!.GetValue<string>());
        Assert.Empty(Directory.GetDirectories(Path.Combine(f.Main.Data, "state", "runtime-runs")));
        var dto = f.Owner.BuildDto();
        Assert.Equal("claude-code", dto["runtime"]!.GetValue<string>());
        Assert.Equal("cli-configured-model", dto["modelKey"]!.GetValue<string>());
        Assert.Null(dto["defaultModelKey"]);
        Assert.Equal("cli-configured-model", WebUiContract.Session(snapshot, f.Main.Configuration.Models, false, false)["modelKey"]!.GetValue<string>());
        await f.PeerAsync(new JsonObject());
        await f.RunAsync("second input");
        Assert.True(f.Owner.Entry.LastBackgroundProcessorFailure is null, f.Owner.Entry.LastBackgroundProcessorFailure + (File.Exists(Path.Combine(f.Cwd, "peer-error.txt")) ? File.ReadAllText(Path.Combine(f.Cwd, "peer-error.txt")) : ""));
        var second = f.Lines("inputs.jsonl")[1];
        Assert.True(second["resumed"]!.GetValue<bool>());
        Assert.Equal(first["id"]!.GetValue<string>(), second["id"]!.GetValue<string>());
        var input = second["input"]!.ToJsonString();
        Assert.Contains("second input", input);
        Assert.DoesNotContain("first input", input);
        Assert.Equal(1.25, f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["lastResult"]!["total_cost_usd"]!.GetValue<double>());
        var activePath = Path.Combine(f.Main.Data, "state", "sessions", "external.json");
        var authority = JsonNode.Parse(await File.ReadAllTextAsync(activePath))!.AsObject();
        Assert.Equal(2, authority["sessionStateVersion"]!.GetValue<int>());
        Assert.Equal(2, SessionAuthorityDocument.Parse(authority.ToJsonString(), "external").CloneRoot()["sessionStateVersion"]!.GetValue<int>());
        var catalog = f.Main.Manager.Catalog.Get("external")!;
        Assert.Equal("claude-code", catalog["runtime"]!.GetValue<string>());
        Assert.Null(catalog["externalRuntime"]?["transcript"]);
        Assert.Equal("cli-configured-model", f.Main.Manager.CatalogPresentations(["external"], false)[0]["modelKey"]!.GetValue<string>());
        Assert.True((await f.Main.Manager.ClearAsync(f.Owner)).Cleared);
        await f.RunAsync("after Clear");
        var fresh = f.Lines("inputs.jsonl")[2];
        Assert.False(fresh["resumed"]!.GetValue<bool>());
        Assert.NotEqual(second["id"]!.GetValue<string>(), fresh["id"]!.GetValue<string>());
    }

    private static async Task AssertRevokedAsync(ClaudeRuntimeFixture f, string bearer)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, f.Main.Manager.RuntimeMcpEndpoint);
        request.Headers.TryAddWithoutValidation("Authorization", bearer);
        request.Headers.Accept.ParseAdd("application/json"); request.Headers.Accept.ParseAdd("text/event-stream");
        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        using var response = await f.Main.Http.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
