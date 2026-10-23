using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Installed_Main_ignores_retired_root_and_resource_environment_controls()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        var retired = Path.Combine(h.Temp.Path, "retired resources");
        Directory.CreateDirectory(Path.Combine(retired, "assets"));
        await File.WriteAllTextAsync(Path.Combine(retired, "index.html"), "retired-webui");
        h.Start(new()
        {
            ["FOXWARM_APP_ROOT"] = retired,
            ["FOXWARM_EXPERIMENT_DATA_ROOT"] = retired,
            ["FOXWARM_EXPERIMENT_TOOL_ROOT"] = retired,
            ["FOXWARM_EXPERIMENT_SKILLS_ROOT"] = retired,
            ["FOXWARM_EXPERIMENT_WEBUI_DIST"] = retired,
            ["FOXWARM_EXPERIMENT_MONTY_BINARY"] = Path.Combine(retired, "not-executable"),
            ["FOXWARM_EXPERIMENT_INSTRUCTIONS"] = "retired-instructions",
        });
        await h.Ready();
        var html = await h.Client.GetStringAsync("/");
        Assert.Contains("authenticated-app-fixture", html);
        Assert.DoesNotContain("retired-webui", html);
        var roots = (await h.Client.GetFromJsonAsync<JsonObject>("/api/vscode-web/fs/workspace-roots"))!;
        Assert.Equal(h.Installation, Path.TrimEndingDirectorySeparator(roots["roots"]!["app"]!["path"]!.GetValue<string>()));
        Assert.Equal(h.Data, roots["roots"]!["data"]!["path"]!.GetValue<string>());
        var created = await h.Client.PostAsJsonAsync("/api/sessions", new { agentId = "main", sessionId = "normal-roots" });
        created.EnsureSuccessStatusCode();
        Assert.True(Directory.Exists(Path.Combine(h.Work, "memory")));
        Assert.False(Directory.Exists(Path.Combine(retired, "memory")));
        Assert.False(Directory.Exists(Path.Combine(retired, "state")));
        await h.Stop();
    }
}
