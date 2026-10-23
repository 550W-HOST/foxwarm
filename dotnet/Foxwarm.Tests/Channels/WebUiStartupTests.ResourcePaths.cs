using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Installed_Main_ignores_retired_root_and_resource_environment_controls()
    {
        await using var h = new Host(codeAssets: true);
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var retired = Path.Combine(h.Temp.Path, "retired resources");
        Directory.CreateDirectory(Path.Combine(retired, "assets"));
        await File.WriteAllTextAsync(Path.Combine(retired, "index.html"), "retired-webui");
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
        var ignoredConfig = Path.Combine(retired, "config.yaml");
        await File.WriteAllTextAsync(ignoredConfig, "invalid: [unterminated");
        var ignoredWorkspace = Path.Combine(retired, "foxwarm.code-workspace");
        h.Start(
            new()
            {
                ["FOXWARM_CONFIG_PATH"] = ignoredConfig,
                ["CONFIG_PATH"] = ignoredConfig,
                ["FOXWARM_VSCODE_WEB_ASSET_DIR"] = retired,
                ["FOXWARM_VSCODE_YAML_EXTENSION_DIR"] = retired,
                ["FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI"] = "file:///retired",
                ["FOXWARM_VSCODE_WEB_WORKSPACE_PATH"] = ignoredWorkspace,
                ["FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN"] = "https://foreign.example",
                ["FOXWARM_APP_ROOT"] = retired,
                ["FOXWARM_EXPERIMENT_DATA_ROOT"] = retired,
                ["FOXWARM_EXPERIMENT_TOOL_ROOT"] = retired,
                ["FOXWARM_EXPERIMENT_SKILLS_ROOT"] = retired,
                ["FOXWARM_EXPERIMENT_WEBUI_DIST"] = retired,
                ["FOXWARM_EXPERIMENT_MONTY_BINARY"] = Path.Combine(retired, "not-executable"),
                ["FOXWARM_EXPERIMENT_INSTRUCTIONS"] = "retired-instructions",
            }
        );
        await h.Ready();
        var html = await h.Client.GetStringAsync("/");
        Assert.Contains("authenticated-app-fixture", html);
        Assert.DoesNotContain("retired-webui", html);
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
        Assert.False(File.Exists(ignoredWorkspace));
        Assert.Equal("invalid: [unterminated", await File.ReadAllTextAsync(ignoredConfig));
        var created = await h.Client.PostAsJsonAsync(
            "/api/sessions",
            new { agentId = "main", sessionId = "normal-roots" }
        );
        created.EnsureSuccessStatusCode();
        Assert.True(Directory.Exists(Path.Combine(h.Work, "memory")));
        Assert.False(Directory.Exists(Path.Combine(retired, "memory")));
        Assert.False(Directory.Exists(Path.Combine(retired, "state")));
        await h.Stop();
    }
}
