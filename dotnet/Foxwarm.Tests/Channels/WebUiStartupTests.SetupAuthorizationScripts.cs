using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Setup_authorization_http_validates_and_saves_scripted_policies()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(h.ConfigPath, $"bot: {{httpPort: {h.Port}}}\nvector: false\n");
        h.Start();
        await h.Ready();

        var initial = await h.Client.GetFromJsonAsync<JsonObject>("/api/setup/authorization");
        Assert.NotNull(initial);
        var rev0 = initial["revision"]!.GetValue<string>();

        const string validScript = """
            version: 1
            defaultAction: allow
            data:
              blocked: [guest]
            script: |
              return [{"id": f"no-{a}", "agent": a, "action": "deny"} for a in data["blocked"]]
            """;

        var saved = await h.Client.PostAsJsonAsync(
            "/api/setup/authorization",
            new { yaml = validScript, revision = rev0 }
        );
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var savedBody = await saved.Content.ReadFromJsonAsync<JsonObject>();
        Assert.NotNull(savedBody);
        var rev1 = savedBody["revision"]!.GetValue<string>();
        Assert.NotEqual(rev0, rev1);
        Assert.Equal(validScript, savedBody["yaml"]!.GetValue<string>());

        // Bad script returns 400 with line number and leaves active policy unchanged.
        var bad = await h.Client.PostAsJsonAsync(
            "/api/setup/authorization",
            new
            {
                yaml = "version: 1\nscript: |\n  import time\n  time.time()\n  return []\n",
                revision = rev1,
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        var badBody = await bad.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains("line 2", badBody!["error"]!.GetValue<string>());
        Assert.Contains(
            "clock",
            badBody["error"]!.GetValue<string>(),
            StringComparison.OrdinalIgnoreCase
        );

        // Bad output rule returns 400 with rule index and leaves active policy unchanged.
        var badRule = await h.Client.PostAsJsonAsync(
            "/api/setup/authorization",
            new
            {
                yaml = "version: 1\nscript: |\n  return [{'id': 'ok', 'action': 'allow'}, {'id': 'bad', 'action': 'nope'}]\n",
                revision = rev1,
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, badRule.StatusCode);
        var badRuleBody = await badRule.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains("rule[1]", badRuleBody!["error"]!.GetValue<string>());

        var reloaded = await h.Client.GetFromJsonAsync<JsonObject>("/api/setup/authorization");
        Assert.Equal(rev1, reloaded!["revision"]!.GetValue<string>());
        Assert.Null(reloaded["error"]);
        Assert.True(reloaded["scripted"]!.GetValue<bool>());
        Assert.Single(reloaded["expandedRules"]!.AsArray());
        Assert.Equal(
            "no-guest",
            reloaded["expandedRules"]![0]!["id"]!.GetValue<string>()
        );

        // Preview endpoint evaluates unsaved scripted YAML without modifying active policy.
        var preview = await h.Client.PostAsJsonAsync(
            "/api/setup/authorization/preview",
            new
            {
                yaml = "version: 1\ndefaultAction: deny\ndata: { names: [a, b] }\nscript: |\n  return [{'id': f'r-{n}', 'agent': n, 'action': 'allow'} for n in data['names']]\n",
            }
        );
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        var previewBody = await preview.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(previewBody!["scripted"]!.GetValue<bool>());
        Assert.Equal("deny", previewBody["defaultAction"]!.GetValue<string>());
        Assert.Equal(2, previewBody["expandedRules"]!.AsArray().Count);

        var badPreview = await h.Client.PostAsJsonAsync(
            "/api/setup/authorization/preview",
            new { yaml = "version: 1\nscript: |\n  return [1 / 0]\n" }
        );
        Assert.Equal(HttpStatusCode.BadRequest, badPreview.StatusCode);
        var badPreviewBody = await badPreview.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains("line 1", badPreviewBody!["error"]!.GetValue<string>());

        // Active revision is still rev1 after preview calls.
        var afterPreview = await h.Client.GetFromJsonAsync<JsonObject>("/api/setup/authorization");
        Assert.Equal(rev1, afterPreview!["revision"]!.GetValue<string>());
    }

    [Fact]
    public async Task Agents_http_api_accepts_and_validates_scripted_rule_layers()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(h.ConfigPath, $"bot: {{httpPort: {h.Port}}}\nvector: false\n");
        h.Start();
        await h.Ready();

        // Create Agent with scripted layer via POST /api/agents
        var created = await h.Client.PostAsJsonAsync(
            "/api/agents",
            new
            {
                agentId = "scripted-worker",
                rules = new
                {
                    data = new { ops = new[] { "env.read" } },
                    script = "return [{'id': f'allow-{o}', 'op': o, 'node': {'exact': 'master'}, 'action': 'allow'} for o in data['ops']] + [{'id': 'deny-all', 'action': 'deny'}]",
                },
            }
        );
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);

        var agents = await h.Client.GetFromJsonAsync<JsonObject>("/api/agents");
        var row = agents!["agents"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(item => item["id"]!.GetValue<string>() == "scripted-worker");
        Assert.IsType<JsonObject>(row["rules"]);
        Assert.Equal(2, row["ruleCount"]!.GetValue<int>());
        Assert.Equal(2, row["expandedRules"]!.AsArray().Count);
        Assert.Equal("allow-env.read", row["expandedRules"]![0]!["id"]!.GetValue<string>());
        Assert.True(row["restricted"]!.GetValue<bool>());

        // Agent rules preview endpoint evaluates unsaved script layers without modifying the Agent.
        var preview = await h.Client.PostAsJsonAsync(
            "/api/agents/rules/preview",
            new
            {
                rules = new
                {
                    data = new { ops = new[] { "env.read", "env.write" } },
                    script = "return [{'id': f'allow-{o}', 'op': o, 'action': 'allow'} for o in data['ops']]",
                },
            }
        );
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        var previewBody = await preview.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(previewBody!["scripted"]!.GetValue<bool>());
        Assert.Equal(2, previewBody["expandedRules"]!.AsArray().Count);

        var badPreview = await h.Client.PostAsJsonAsync(
            "/api/agents/rules/preview",
            new
            {
                rules = new { script = "return [{'id': 'bad', 'agent': 'x', 'action': 'allow'}]" },
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, badPreview.StatusCode);
        var badPreviewBody = await badPreview.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains("rule[0]", badPreviewBody!["error"]!.GetValue<string>());

        // Bad script via PUT /api/agents/{id} returns 400 with line/index error and keeps rules unchanged.
        var badPut = await h.Client.PutAsJsonAsync(
            "/api/agents/scripted-worker",
            new
            {
                rules = new
                {
                    script = "return [{'id': 'bad-caller', 'agent': 'x', 'action': 'allow'}]",
                },
            }
        );
        Assert.Equal(HttpStatusCode.BadRequest, badPut.StatusCode);
        var badBody = await badPut.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Contains("rule[0]", badBody!["error"]!.GetValue<string>());

        // Valid update via PUT /api/agents/{id} replaces rules and returns the stored object.
        var goodPut = await h.Client.PutAsJsonAsync(
            "/api/agents/scripted-worker",
            new
            {
                rules = new
                {
                    script = "return [{'id': 'allow-read', 'op': 'env.read', 'node': {'exact': 'master'}, 'action': 'allow'}]",
                },
            }
        );
        Assert.Equal(HttpStatusCode.OK, goodPut.StatusCode);
        var goodBody = await goodPut.Content.ReadFromJsonAsync<JsonObject>();
        Assert.IsType<JsonObject>(goodBody!["agent"]!["rules"]);
    }
}
