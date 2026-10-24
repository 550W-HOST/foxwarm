using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

internal static class CanonicalSourceFixture
{
    internal static async Task<JsonObject> RunAsync(JsonObject input)
    {
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "FOXWARM_TS_ROOT is required for frozen Source fixtures."
            );
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repository,
                ArgumentList =
                {
                    Path.Combine(
                        repository,
                        "dotnet",
                        "Foxwarm.Tests",
                        "Fixtures",
                        "canonical-entry-fixture-ts.mjs"
                    ),
                },
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        await process.StandardInput.WriteAsync(input.ToJsonString());
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True(process.ExitCode == 0, await error);
        return JsonNode.Parse(await output)!.AsObject();
    }
}

public sealed class CanonicalPathsTests
{
    [Theory]
    [InlineData("default")]
    [InlineData("pointer-relative")]
    [InlineData("pointer-tilde")]
    [InlineData("pointer-tilde-no-home")]
    [InlineData("env-relative")]
    [InlineData("env-tilde")]
    [InlineData("path-overrides")]
    [InlineData("retired-controls")]
    public async Task Captured_paths_match_frozen_Source_without_shell_cwd_or_parent_discovery(
        string kind
    )
    {
        using var temp = new TempDirectory();
        var app = Path.Combine(temp.Path, "installed application");
        var resource = Path.Combine(temp.Path, "binary resources");
        var home = Path.Combine(temp.Path, "home");
        Directory.CreateDirectory(app);
        Directory.CreateDirectory(resource);
        Directory.CreateDirectory(home);
        var env = new JsonObject { ["HOME"] = home };
        if (kind == "pointer-tilde-no-home")
            env.Remove("HOME");
        if (
            kind.StartsWith("pointer", StringComparison.Ordinal)
            || kind.StartsWith("env", StringComparison.Ordinal)
        )
            await File.WriteAllTextAsync(
                Path.Combine(app, "data_dir"),
                kind.StartsWith("pointer-tilde", StringComparison.Ordinal)
                    ? " ~/pointer data \n"
                    : " pointer data \n"
            );
        if (kind.StartsWith("env", StringComparison.Ordinal))
            env["FOXWARM_DATA_DIR"] = kind == "env-tilde" ? " ~/selected data " : " selected data ";
        if (kind == "path-overrides")
        {
            env["MCP_CONFIG_PATH"] = "~/external mcp.json";
        }
        if (kind == "retired-controls")
            foreach (
                var name in new[]
                {
                    "FOXWARM_APP_ROOT",
                    "FOXWARM_EXPERIMENT_DATA_ROOT",
                    "FOXWARM_EXPERIMENT_TOOL_ROOT",
                    "FOXWARM_EXPERIMENT_SKILLS_ROOT",
                }
            )
                env[name] = Path.Combine(temp.Path, "retired root");
        string? EnvironmentValue(string key) => env[key]?.GetValue<string>();
        var initial = HostPaths.Capture(app, resource, EnvironmentValue);
        Directory.CreateDirectory(Path.GetDirectoryName(initial.ConfigPath)!);
        var raw =
            kind == "path-overrides"
                ? "paths:\n  agentsDir: 'custom agents'\n  skillsDir: '~/global skills'\n  mcpConfigPath: 'ignored mcp.json'\n"
                : "{}\n";
        await File.WriteAllTextAsync(initial.ConfigPath, raw);
        var paths = initial.WithConfiguration(
            ConfigurationYaml.Parse(raw, "fixture"),
            EnvironmentValue
        );
        var expected = await CanonicalSourceFixture.RunAsync(
            new JsonObject { ["applicationRoot"] = app, ["environment"] = env.DeepClone() }
        );
        foreach (
            var (key, actual) in new[]
            {
                ("data", paths.DataRoot),
                ("config", paths.ConfigPath),
                ("models", paths.ModelsPath),
                ("agents", paths.AgentsRoot),
                ("skills", paths.SkillsRoot),
                ("mcp", paths.McpConfigPath),
                ("workspace", paths.AgentsRoot),
            }
        )
            Assert.Equal(expected[key]!.GetValue<string>(), actual);
        Assert.Equal(resource, paths.ResourceRoot);
        Assert.Equal(app, paths.ApplicationRoot);
        Assert.Equal(3001, expected["port"]!.GetValue<int>());
    }

    [Fact]
    public async Task Source_metadata_directory_membership_memory_fallback_and_unknown_fields_have_one_owner()
    {
        using var temp = new TempDirectory();
        var app = Path.Combine(temp.Path, "app");
        Directory.CreateDirectory(Path.Combine(app, "state"));
        var root = Path.Combine(app, "agents");
        foreach (
            var name in new[] { "main", "base", "child", "directory_only", ".scratch", "bad name" }
        )
            Directory.CreateDirectory(Path.Combine(root, name, "memory"));
        var file = Path.Combine(app, "state", "agents.json");
        var metadata = JsonNode.Parse(
            """
            {"child":{"inherit":"base","isolated":true,"isolatedNode":"retained-node","toolRules":[{"effect":"deny","source":"node","node":"master","tool":"read"}],"extension":{"keep":[1,"opaque"]}},"metadata_only":{"custom":true},"version":{"privateExtension":4}}
            """
        )!;
        await File.WriteAllTextAsync(file, metadata.ToJsonString());
        await File.WriteAllTextAsync(
            Path.Combine(root, "main", "memory", "00_SYSTEM.md"),
            "retained main fallback"
        );
        await File.WriteAllTextAsync(
            Path.Combine(root, "base", "memory", "MEMORY.md"),
            "inherited retained knowledge"
        );
        await File.WriteAllTextAsync(
            Path.Combine(root, "child", "memory", "MEMORY.md"),
            "child knowledge"
        );
        await File.WriteAllTextAsync(
            Path.Combine(root, "child", "arbitrary.bin"),
            "unmoved contents"
        );
        var expected = await CanonicalSourceFixture.RunAsync(
            new JsonObject
            {
                ["applicationRoot"] = app,
                ["operation"] = "metadata",
                ["update"] = new JsonObject
                {
                    ["agent"] = "child",
                    ["fields"] = new JsonObject { ["inherit"] = "directory_only" },
                },
            }
        );
        // Restore the same original fixture before exercising the C# owner.
        await File.WriteAllTextAsync(file, metadata.ToJsonString());
        var agents = new AgentCatalog(app, root, canonicalLayout: true);
        Assert.Equal(
            expected["members"]!.AsArray().Select(item => item!.GetValue<string>()),
            agents.List()
        );
        Assert.False(agents.Exists("metadata_only"));
        Assert.True(agents.Exists("directory_only"));
        Assert.Equal(expected["main"]!.GetValue<string>(), agents.AgentDirectory("main"));
        Assert.Equal(expected["mainMemory"]!.GetValue<string>(), agents.MemoryDirectory("main"));
        Assert.Equal(expected["framework"]!.GetValue<string>(), agents.FrameworkSystemPath);
        await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
        Assert.False(File.Exists(agents.FrameworkSystemPath));
        var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(app, "skills")));
        var prompt = await memory.BuildAsync("child", "child/main", "local/wire");
        Assert.Contains("retained main fallback", prompt);
        Assert.Contains("inherited retained knowledge", prompt);
        Assert.Contains("child knowledge", prompt);
        await agents.SetInheritAsync("child", "directory_only");
        Assert.True(
            JsonNode.DeepEquals(
                expected["written"],
                JsonNode.Parse(await File.ReadAllTextAsync(file))
            )
        );
        await agents.SetIsolationAsync("child", null, false, new JsonArray());
        var reopened = new AgentCatalog(app, root, canonicalLayout: true);
        Assert.Equal("directory_only", reopened.Inherit("child"));
        Assert.True(
            JsonNode.DeepEquals(
                metadata["child"]!["extension"],
                reopened.MetadataSnapshot()["child"]!["extension"]
            )
        );
        Assert.True(
            IsolatedToolCompatibility.Metadata(reopened.MetadataSnapshot()["child"]).Isolated
        );
        Directory.CreateDirectory(Path.Combine(root, "added_after_start"));
        Assert.True(agents.Exists("added_after_start"));
        await agents.CreateAsync("created", "new memory", "base");
        Assert.True(Directory.Exists(Path.Combine(root, "created", "memory")));
        Assert.Null(JsonNode.Parse(await File.ReadAllTextAsync(file))!["agents"]);
        Assert.Equal(
            "unmoved contents",
            await File.ReadAllTextAsync(Path.Combine(root, "child", "arbitrary.bin"))
        );
        Assert.False(Directory.Exists(Path.Combine(app, "memory")));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Identified_Csharp_layout_reopens_without_relocation_policy_rebase_or_second_main_tree(
        int version
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var workspace = Path.Combine(temp.Path, "original workspace");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(workspace, "agents", "alpha", "memory"));
        Directory.CreateDirectory(Path.Combine(workspace, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(workspace, "memory", "MEMORY.md"),
            "original main knowledge"
        );
        await File.WriteAllTextAsync(
            Path.Combine(workspace, "keep.txt"),
            "arbitrary original main file"
        );
        var index = new JsonObject { ["version"] = version, ["agents"] = new JsonArray("alpha") };
        if (version == 2)
            index["metadata"] = new JsonObject
            {
                ["alpha"] = new JsonObject { ["inherit"] = "main", ["unknown"] = 42 },
            };
        var file = Path.Combine(data, "state", "agents.json");
        await File.WriteAllTextAsync(file, index.ToJsonString());
        Assert.Throws<InvalidDataException>(() =>
            new AgentCatalog(data, Path.Combine(data, "agents"), canonicalLayout: true)
        );
        Assert.False(Directory.Exists(Path.Combine(data, "agents")));
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        await using (
            var manager = new SessionManager(data, workspace, options, HostModels.ForTest(options))
        )
        {
            await manager.LoadMainHostAsync();
            Assert.Equal(workspace, manager.ToolWorkspace);
            Assert.Equal(workspace, manager.AgentDirectory("main"));
            Assert.Equal(
                Path.Combine(workspace, "agents", "alpha"),
                manager.AgentDirectory("alpha")
            );
            var owner = await manager.CreateNamedAsync("main", "retained", null, null);
            await owner.UpdateCwdAsync(workspace);
        }
        var catalog = new AgentCatalog(data, workspace);
        await catalog.SetInheritAsync("alpha", "main");
        var stored = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
        Assert.Equal(2, stored["version"]!.GetValue<int>());
        if (version == 2)
            Assert.Equal(42, stored["metadata"]!["alpha"]!["unknown"]!.GetValue<int>());
        await using (
            var reopened = new SessionManager(data, workspace, options, HostModels.ForTest(options))
        )
        {
            await reopened.LoadMainHostAsync();
            var owner = await reopened.RequiredAsync("retained");
            Assert.Equal(
                workspace,
                owner.Entry.Snapshot().AuthorityEnvelope["cwd"]!.GetValue<string>()
            );
            Assert.Contains(
                "original main knowledge",
                owner.Entry.Snapshot().AuthorityEnvelope[
                    "persistentMemorySnapshot"
                ]!.GetValue<string>()
            );
        }
        Assert.Equal(
            "arbitrary original main file",
            await File.ReadAllTextAsync(Path.Combine(workspace, "keep.txt"))
        );
        Assert.False(Directory.Exists(Path.Combine(data, "agents", "main")));
        Assert.False(Directory.Exists(Path.Combine(workspace, "agents", "main")));
    }

    [Fact]
    public async Task Normal_manager_uses_Agents_policy_base_and_preserves_native_cwd_and_isolation()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var paths = HostPaths.ForDataRoot(data) with
        {
            SkillsRoot = Path.Combine(temp.Path, "configured global skills"),
            McpConfigPath = Path.Combine(temp.Path, "external mcp", "configured.json"),
        };
        Directory.CreateDirectory(Path.Combine(paths.SkillsRoot, "configured-global"));
        await File.WriteAllTextAsync(
            Path.Combine(paths.SkillsRoot, "configured-global", "SKILL.md"),
            "---\nname: configured-global\ndescription: Captured global skill root\n---\nBody\n"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(paths.McpConfigPath)!);
        await File.WriteAllTextAsync(
            paths.McpConfigPath,
            "{\"servers\":{\"configured-outbound\":{\"transport\":\"stdio\",\"command\":\"never-launch\",\"enable\":false}}}"
        );
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "agents.json"),
            "{\"main\":{\"isolated\":true}}"
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "existing", null, null);
        var listed = await manager.SkillAsync(owner, new JsonObject { ["action"] = "list" });
        Assert.Contains("configured-global", listed.ToJsonString());
        Assert.Contains(
            "configured-outbound",
            (await manager.OutboundMcp.ListServersAsync(CancellationToken.None)).ToJsonString()
        );
        Assert.False(File.Exists(Path.Combine(data, "state", "mcp.json")));
        var own = Path.Combine(paths.AgentsRoot, "main");
        var files = new WorkspaceTools(own);
        Assert.Equal(own, manager.AgentDirectory("main"));
        Assert.Equal(paths.AgentsRoot, manager.ToolWorkspace);
        await manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                """
                version: 1
                defaultAction: deny
                rules:
                  - id: agent-tree
                    action: allow
                    match:
                      path: {allWithin: '${workspace}'}
                """
            ),
            CancellationToken.None
        );
        await manager.AuthorizeToolAsync(
            owner,
            new("write", "node", "write", new JsonObject { ["filePath"] = "ordinary.txt" }),
            files,
            CancellationToken.None
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
            manager.AuthorizeToolAsync(
                owner,
                new(
                    "write",
                    "node",
                    "write",
                    new JsonObject { ["filePath"] = Path.Combine(data, "outside.txt") }
                ),
                files,
                CancellationToken.None
            )
        );
        // Canonical main/agents is ordinary own content, unlike the retained sibling-Agent tree.
        manager.RequireMainFileSourcePath(owner, Path.Combine(own, "agents", "script.py"));
        Assert.Throws<ToolAuthorizationDeniedException>(() =>
            manager.RequireMainFileSourcePath(owner, Path.Combine(data, "outside.py"))
        );
        var request = new ToolAuthorizationRequest(
            "node",
            "read",
            null,
            new(),
            [new("filePath", "agents/test", Path.Combine(own, "agents", "test"), "master")],
            "main",
            owner.Id,
            "master",
            paths.AgentsRoot,
            own,
            Path.Combine(own, "memory")
        );
        IsolatedToolCompatibility.Check(new(true, null, new()), request, _ => null);
        Assert.Throws<ToolAuthorizationDeniedException>(() =>
            IsolatedToolCompatibility.Check(
                new(true, null, new()),
                request with
                {
                    Workspace = own,
                },
                _ => null
            )
        );
    }

    [Fact]
    public async Task Captured_config_and_Mcp_paths_use_existing_installers_without_retargeting_live_owners()
    {
        using var temp = new TempDirectory();
        var app = Path.Combine(temp.Path, "app");
        Directory.CreateDirectory(app);
        var paths = HostPaths.ForDataRoot(Path.Combine(app, "data"), app) with
        {
            ConfigPath = Path.Combine(app, "settings", "custom.yaml"),
            McpConfigPath = Path.Combine(app, "external", "mcp.json"),
        };
        Directory.CreateDirectory(Path.GetDirectoryName(paths.ConfigPath)!);
        await File.WriteAllTextAsync(paths.ConfigPath, "paths: {agentsDir: 'original agents'}\n");
        var config = new ModelConfiguration(paths);
        var saved = await config.SaveAppAsync(
            "paths: {agentsDir: 'next agents'}\nvector: {enabled: false}\n"
        );
        Assert.Contains("paths", saved["restartRequired"]!.ToString());
        Assert.Contains("vector", saved["restartRequired"]!.ToString());
        Assert.Equal(Path.Combine(app, "original agents"), config.Paths.AgentsRoot);
        Assert.Equal(
            Path.Combine(app, "next agents"),
            new ModelConfiguration(paths).Paths.AgentsRoot
        );
        Assert.False(File.Exists(Path.Combine(paths.DataRoot, "state", "config.yaml")));
        Directory.CreateDirectory(Path.GetDirectoryName(paths.McpConfigPath)!);
        await File.WriteAllTextAsync(
            paths.McpConfigPath,
            "{\"servers\":{\"retained\":{\"command\":\"never-launch\",\"transport\":\"stdio\",\"enable\":false}}}"
        );
        var mcp = new McpConfiguration(paths.DataRoot, paths.McpConfigPath);
        Assert.Equal("never-launch", mcp.Snapshot()["retained"]!["command"]!.GetValue<string>());
        await mcp.UpdateAsync(
            "retained",
            new JsonObject { ["description"] = "updated retained config" },
            false
        );
        Assert.Equal(
            "updated retained config",
            new McpConfiguration(paths.DataRoot, paths.McpConfigPath).Snapshot()["retained"]![
                "description"
            ]!.GetValue<string>()
        );
        Assert.False(File.Exists(Path.Combine(paths.DataRoot, "state", "mcp.json")));
    }

    [Fact]
    public async Task Directory_membership_does_not_recover_a_Session_lifetime_or_remove_unowned_data_during_identity_recovery()
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(Path.Combine(temp.Path, "data"));
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        SessionManager Manager() =>
            new(
                paths.DataRoot,
                paths.AgentsRoot,
                options,
                HostModels.ForTest(options),
                hostPaths: paths
            );
        await using (var seed = Manager())
        {
            await seed.LoadMainHostAsync();
            await seed.CreateNamedAsync("main", "old", null, null);
            await seed.CreateAgentAsync("claimed", false, "owned temporary knowledge", "main");
        }
        var unrelated = Path.Combine(paths.AgentsRoot, "unindexed", "keep.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(unrelated)!);
        await File.WriteAllTextAsync(unrelated, "ordinary unowned directory");
        var journal = new SessionIdentityMoveJournal(paths.DataRoot);
        journal.Write(
            new("rolling-back", "old", "claimed/main", "main", [], true, "claimed", 1000)
        );
        await using var recovered = Manager();
        await recovered.LoadMainHostAsync();
        Assert.Equal("old", (await recovered.RequiredAsync("old")).Id);
        Assert.Contains("unindexed", recovered.Agents());
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            recovered.RequiredAsync("unindexed/main")
        );
        Assert.False(Directory.Exists(Path.Combine(paths.AgentsRoot, "claimed")));
        Assert.False(
            JsonNode
                .Parse(
                    await File.ReadAllTextAsync(
                        Path.Combine(paths.DataRoot, "state", "agents.json")
                    )
                )!
                .AsObject()
                .ContainsKey("claimed")
        );
        Assert.Equal("ordinary unowned directory", await File.ReadAllTextAsync(unrelated));
        Assert.False(File.Exists(journal.FilePath));
    }

    [Fact]
    public async Task Source_authority_without_metadata_bootstraps_an_explicit_new_Agents_root_without_relocating_files()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var originalMemory = Path.Combine(data, "agents", "main", "memory", "MEMORY.md");
        Directory.CreateDirectory(Path.GetDirectoryName(originalMemory)!);
        await File.WriteAllTextAsync(originalMemory, "existing Source knowledge");
        var nextAgents = Path.Combine(data, "next-agents");
        var paths = HostPaths.ForDataRoot(data);
        Directory.CreateDirectory(Path.GetDirectoryName(paths.ConfigPath)!);
        await File.WriteAllTextAsync(
            paths.ConfigPath,
            "paths: {agentsDir: '" + nextAgents + "'}\n"
        );
        var expected = await CanonicalSourceFixture.RunAsync(
            new JsonObject
            {
                ["applicationRoot"] = data,
                ["operation"] = "authority",
                ["session"] = new JsonObject
                {
                    ["agent"] = "main",
                    ["history"] = new JsonArray(),
                    ["persistentMemorySnapshot"] = "existing Source snapshot",
                    ["queue"] = new JsonArray(),
                    ["busy"] = false,
                    ["currentNode"] = "master",
                    ["lastAppliedMailboxId"] = 0,
                },
            }
        );
        // Catalog membership has its own established owner; authority JSON is not discovery evidence.
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("existing", 0)]);
        }
        var authorityFile = Path.Combine(data, "state", "sessions", "existing.json");
        Directory.CreateDirectory(Path.GetDirectoryName(authorityFile)!);
        var authority = expected["authority"]!.ToJsonString();
        await File.WriteAllTextAsync(authorityFile, authority);
        Assert.False(File.Exists(Path.Combine(data, "state", "agents.json")));
        Assert.False(Directory.Exists(Path.Combine(nextAgents, "main")));
        var config = new ModelConfiguration(paths);
        Assert.Equal(expected["agents"]!.GetValue<string>(), config.Paths.AgentsRoot);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            config.Paths.AgentsRoot,
            options,
            HostModels.ForTest(options),
            hostPaths: config.Paths
        );
        await manager.LoadMainHostAsync();
        Assert.Equal(Path.Combine(nextAgents, "main"), manager.AgentDirectory("main"));
        Assert.True(File.Exists(Path.Combine(nextAgents, "main", "memory", "MEMORY.md")));
        Assert.Equal("existing Source knowledge", await File.ReadAllTextAsync(originalMemory));
        Assert.Equal(authority, await File.ReadAllTextAsync(authorityFile));
        Assert.False(File.Exists(Path.Combine(data, "state", "agents.json")));
    }

    [Fact]
    public async Task Explicit_main_only_retained_caller_reopens_its_original_workspace_without_an_Agent_envelope()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var original = Path.Combine(temp.Path, "old main workspace");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local",
            "",
            "",
            713
        );
        await using (
            var seed = new SessionManager(data, original, options, HostModels.ForTest(options))
        )
        {
            await seed.LoadMainHostAsync();
            await seed.CreateNamedAsync("main", "retained-main-only", null, null);
        }
        Assert.False(File.Exists(Path.Combine(data, "state", "agents.json")));
        await File.WriteAllTextAsync(Path.Combine(original, "keep.txt"), "original main file");
        await using var reopened = new SessionManager(
            data,
            original,
            options,
            HostModels.ForTest(options)
        );
        await reopened.LoadMainHostAsync();
        Assert.Equal("retained-main-only", (await reopened.RequiredAsync("retained-main-only")).Id);
        Assert.Equal(original, reopened.AgentDirectory("main"));
        Assert.Equal(original, reopened.ToolWorkspace);
        Assert.False(Directory.Exists(Path.Combine(data, "agents", "main")));
        Assert.Equal(
            "original main file",
            await File.ReadAllTextAsync(Path.Combine(original, "keep.txt"))
        );
    }
}
