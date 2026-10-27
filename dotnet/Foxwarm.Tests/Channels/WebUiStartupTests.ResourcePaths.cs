using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Installed_Main_serves_its_WebUI_and_publishes_canonical_Code_resource_paths()
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
            var target = Path.Combine(assets, file);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await File.WriteAllTextAsync(target, "metadata fixture");
        }
        h.Start();
        await h.Ready();
        var html = await h.Client.GetStringAsync("/");
        Assert.Contains("authenticated-app-fixture", html);
        var roots = (
            await h.Client.GetFromJsonAsync<JsonObject>("/api/vscode-web/fs/workspace-roots")
        )!;
        Assert.Equal(
            h.Installation,
            Path.TrimEndingDirectorySeparator(roots["roots"]!["app"]!["path"]!.GetValue<string>())
        );
        Assert.Equal(h.Data, roots["roots"]!["data"]!["path"]!.GetValue<string>());
        Assert.Equal(h.ConfigPath, roots["configFiles"]!["app"]!["path"]!.GetValue<string>());
        var code = await h.Client.GetStringAsync("/vscode-web/");
        var match = System.Text.RegularExpressions.Regex.Match(code, "data-settings=\"([^\"]+)\"");
        var bootstrap = JsonNode.Parse(WebUtility.HtmlDecode(match.Groups[1].Value))!;
        Assert.Equal(
            Foxwarm.Code.CodeWorkbench.FoxwarmUri(h.Installation),
            (
                "foxwarm://"
                + bootstrap["folderUri"]!["authority"]
                + bootstrap["folderUri"]!["path"]
            ).TrimEnd('/')
        );
        Assert.DoesNotContain(
            "redhat-vscode-yaml",
            bootstrap["additionalBuiltinExtensions"]!.ToJsonString()
        );
        Assert.StartsWith(
            h.Client.BaseAddress!.GetLeftPart(UriPartial.Authority) + "/vscode-web/webview/",
            bootstrap["productConfiguration"]![
                "webviewContentExternalBaseUrlTemplate"
            ]!.GetValue<string>()
        );
        await h.Client.GetStringAsync("/vscode-web/?embedded=true");
        Assert.True(File.Exists(Path.Combine(h.Data, "state/vscode-web/foxwarm.code-workspace")));
        var created = await h.Client.PostAsJsonAsync(
            "/api/sessions",
            new { agentId = "main", sessionId = "normal-roots" }
        );
        created.EnsureSuccessStatusCode();
        Assert.True(Directory.Exists(Path.Combine(h.Work, "memory")));
        await h.Stop();
    }
}
