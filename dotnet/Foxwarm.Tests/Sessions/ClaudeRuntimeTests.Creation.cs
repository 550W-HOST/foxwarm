using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    [Fact]
    public async Task Both_real_creation_tool_entry_points_validate_selection_without_inheriting_external_runtime()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var executor = f.Main.Target.Registry.HostFor(f.Main.Target.Id).RuntimeTools;
        async Task<JsonNode?> Invoke(string name, JsonObject args) => await executor.ExecuteAsync(new JsonObject { ["name"] = name, ["args"] = args }, CancellationToken.None);
        var external = await Invoke("create_session", new JsonObject { ["agentName"] = "main", ["sessionName"] = "from-tool", ["runtime"] = "claude-code" });
        Assert.DoesNotContain("error", external!.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal("claude-code", f.Main.Manager.Find("from-tool")!.Metadata().Runtime);
        var child = await Invoke("create_child_session", new JsonObject { ["suffix"] = "cli-child", ["runtime"] = "claude-code" });
        Assert.DoesNotContain("error", child!.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal("claude-code", f.Main.Manager.Find("target_cli-child")!.Metadata().Runtime);
        var (ordinary, _) = await f.Main.Manager.CreateChildAsync(f.Owner, "ordinary", null, null, null, null);
        Assert.Equal("foxwarm", ordinary.Metadata().Runtime);
        var invalid = await Invoke("create_session", new JsonObject { ["agentName"] = "main", ["sessionName"] = "invalid", ["runtime"] = "other" });
        Assert.Contains("runtime must", invalid!.ToJsonString());
        Assert.Null(f.Main.Manager.Catalog.Get("invalid"));
        var overridden = await Invoke("create_session", new JsonObject { ["agentName"] = "main", ["sessionName"] = "override", ["runtime"] = "claude-code", ["forceModel"] = new JsonObject { ["model"] = "missing" } });
        Assert.NotNull(overridden!["error"]);
        Assert.Null(f.Main.Manager.Catalog.Get("override"));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Main.Manager.CreateChildAsync(f.Owner, "fork", null, null, null, null, fork: true));
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Main.Manager.CreateChildAsync(f.Main.Target, "fork", null, null, null, null, fork: true, runtime: "claude-code"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Owner.UpdateModelAsync(new JsonObject { ["model"] = "wire" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Owner.UpdateModelAsync(new JsonObject { ["effort"] = "high" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Owner.Compactor.StartManualAsync("summary", 50));
        await Assert.ThrowsAsync<InvalidOperationException>(() => f.Main.Manager.RunBtwAsync(f.Owner, "question"));
    }

    [Fact]
    public async Task Human_HTTP_creation_and_cold_metadata_share_the_validated_creation_only_contract()
    {
        await using var f = await InboundMcpFixture.CreateAsync(webUiEnabled: true);
        f.Http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", InboundMcpFixture.Admin);
        async Task<HttpResponseMessage> Post(JsonObject body) => await f.Http.PostAsync(f.Url.Replace("/mcp", "/api/sessions"), new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        using var created = await Post(new JsonObject { ["agentId"] = "main", ["sessionId"] = "external-http", ["runtime"] = "claude-code" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var owner = f.Manager.Find("external-http")!;
        Assert.Equal("claude-code", owner.Metadata().Runtime);
        Assert.Null(owner.Metadata().Model);
        Assert.Null(owner.Entry.Snapshot().AuthorityEnvelope["model"]);
        var dto = f.Manager.CatalogPresentations(["external-http"], includeLocal: false)[0];
        Assert.Equal("claude-code", dto["runtime"]!.GetValue<string>());
        Assert.Equal("Managed by Claude Code", dto["modelLabel"]!.GetValue<string>());
        Assert.Null(dto["defaultModelKey"]);
        using var invalid = await Post(new JsonObject { ["agentId"] = "main", ["sessionId"] = "bad", ["runtime"] = null });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Null(f.Manager.Catalog.Get("bad"));
        using var ordinary = await Post(new JsonObject { ["agentId"] = "main", ["sessionId"] = "ordinary-http" });
        Assert.Equal(HttpStatusCode.OK, ordinary.StatusCode);
        Assert.Equal("foxwarm", f.Manager.Find("ordinary-http")!.Metadata().Runtime);
        using var defaultMain = await Post(new JsonObject { ["agentId"] = "main" });
        using var explicitDefault = await Post(new JsonObject { ["agentId"] = "main", ["runtime"] = "foxwarm" });
        Assert.Equal(HttpStatusCode.OK, defaultMain.StatusCode);
        Assert.Equal(HttpStatusCode.OK, explicitDefault.StatusCode);
        foreach (var response in new[] { defaultMain, explicitDefault })
        {
            var id = JsonNode.Parse(await response.Content.ReadAsStringAsync())!["sessionId"]!.GetValue<string>();
            var ordinaryOwner = f.Manager.Find(id)!;
            Assert.Equal("foxwarm", ordinaryOwner.Metadata().Runtime);
            Assert.Null(ordinaryOwner.Entry.Snapshot().AuthorityEnvelope["model"]);
            Assert.Null(ordinaryOwner.Metadata().ParentSessionId);
        }
    }

    [Fact]
    public async Task External_authority_version_is_explicit_and_rejects_mixed_or_unsupported_checkpoints()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync();
        var path = Path.Combine(f.Main.Data, "state", "sessions", "external.json");
        var root = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        Assert.Equal(2, root["sessionStateVersion"]!.GetValue<int>());
        foreach (var mutate in new Action<JsonObject>[]
        {
            value => value["sessionStateVersion"] = 1,
            value => value["runtime"] = "foxwarm",
            value => value.Remove("runtime"),
            value => value["externalRuntime"]!["status"] = "unsupported",
            value => value["externalRuntime"]!["sessionId"] = "not-a-uuid",
            value => value["externalRuntime"]!["submittedThroughSeq"] = -1,
        })
        {
            var invalid = (JsonObject)root.DeepClone(); mutate(invalid);
            var error = Record.Exception(() => SessionAuthorityDocument.Parse(invalid.ToJsonString(), "external"));
            Assert.True(error is InvalidDataException or UnsupportedSessionAuthorityException, error?.ToString());
        }
        var ordinary = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Main.Data, "state", "sessions", "target.json")))!.AsObject();
        Assert.Equal(1, ordinary["sessionStateVersion"]!.GetValue<int>());
        Assert.Null(ordinary["runtime"]);
        Assert.Equal(1, SessionAuthorityDocument.Parse(ordinary.ToJsonString(), "target").CloneRoot()["sessionStateVersion"]!.GetValue<int>());
    }
}
