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
    }
}
