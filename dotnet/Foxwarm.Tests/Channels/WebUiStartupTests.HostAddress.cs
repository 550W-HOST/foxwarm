using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task YAML_address_is_shared_by_HTTP_Node_Code_and_OAuth_and_changes_only_after_restart()
    {
        await using var h = new Host(codeAssets: true);
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var assets = Path.Combine(h.Installation, "packages/vscode-web/assets/vscode-web");
        foreach (
            var file in new[]
            {
                "out/nls.messages.js",
                "out/vs/workbench/workbench.web.main.internal.css",
                "out/vs/workbench/workbench.web.main.internal.js",
            }
        )
        {
            var path = Path.Combine(assets, file);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, "metadata fixture");
        }
        string Config(string url) => $"url: {url}\nbot: {{httpPort: {h.Port}}}\nvector: false\n";
        await File.WriteAllTextAsync(h.ConfigPath, Config("https://yaml.example/first"));
        var environment = new Dictionary<string, string?>
        {
            ["FOXWARM_PUBLIC_BASE_URL"] = "https://retired.example/wrong",
            ["FOXWARM_HTTP_PORT"] = "invalid",
            ["FOXWARM_BIND_ADDRESS"] = "invalid",
            ["FOXWARM_EXPERIMENT_PORT"] = "invalid",
            ["FOXWARM_EXPERIMENT_BIND_ADDRESS"] = "invalid",
        };
        h.Start(environment);
        await h.Ready();
        async Task Check(string prefix, string publicUrl)
        {
            using var anonymous = new HttpClient { BaseAddress = h.Client.BaseAddress };
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await anonymous.GetAsync(prefix + "/health")).StatusCode
            );
            var login = await anonymous.PostAsJsonAsync(
                prefix + "/api/auth",
                new { token = h.Token }
            );
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);
            Assert.False(login.Headers.Contains("Set-Cookie"));
            var commands = await h.Client.PostAsJsonAsync(
                prefix + "/api/nodes/onboarding/commands",
                new { fallbackUrl = "https://browser.example/browser" }
            );
            Assert.Equal(HttpStatusCode.OK, commands.StatusCode);
            Assert.Equal(
                publicUrl,
                (await commands.Content.ReadFromJsonAsync<JsonObject>())![
                    "baseUrl"
                ]!.GetValue<string>()
            );
            var authorizations = await h.Client.GetFromJsonAsync<JsonObject>(
                prefix + "/api/setup/authorizations"
            );
            Assert.Equal(
                publicUrl + "/api/mcp/oauth/callback",
                authorizations!["callbackUrl"]!.GetValue<string>()
            );
            var html = await h.Client.GetStringAsync(prefix + "/vscode-web/");
            var match = System.Text.RegularExpressions.Regex.Match(
                html,
                "data-settings=\"([^\"]+)\""
            );
            var bootstrap = JsonNode.Parse(WebUtility.HtmlDecode(match.Groups[1].Value))!;
            Assert.Equal(
                publicUrl + "/vscode-web/static",
                bootstrap["productConfiguration"]!["webEndpointUrlTemplate"]!.GetValue<string>()
            );
            Assert.StartsWith(
                publicUrl + "/vscode-web/webview/",
                bootstrap["productConfiguration"]![
                    "webviewContentExternalBaseUrlTemplate"
                ]!.GetValue<string>()
            );
        }
        await Check("/first", "https://yaml.example/first");
        var saved = await h.Client.PostAsJsonAsync(
            "/first/api/setup/config",
            new { yaml = Config("https://saved.example/second") }
        );
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Contains(
            "url",
            (await saved.Content.ReadFromJsonAsync<JsonObject>())![
                "restartRequired"
            ]!.ToJsonString()
        );
        Assert.Contains(
            "url: https://saved.example/second",
            await File.ReadAllTextAsync(h.ConfigPath)
        );
        await Check("/first", "https://yaml.example/first");
        await h.Stop();
        h.Start(environment);
        await h.Ready();
        await Check("/second", "https://saved.example/second");
        await h.Stop();
    }
}
