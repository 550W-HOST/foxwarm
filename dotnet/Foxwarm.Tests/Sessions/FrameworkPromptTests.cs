using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class FrameworkPromptTests
{
    private static Task<string> ReleasedCopyAsync() =>
        File.ReadAllTextAsync(
            Path.Combine(
                VectorFixture.Repository(),
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "released-framework-prompt.md"
            )
        );

    private static AgentCatalog Catalog(TempDirectory temp)
    {
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "agents"));
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        Directory.CreateDirectory(agents.MemoryDirectory("main"));
        return agents;
    }

    [Fact]
    public async Task Startup_removes_unedited_released_copies_and_keeps_edited_replacements()
    {
        var released = await ReleasedCopyAsync();
        foreach (
            var (root, fallback, rootKept, fallbackKept) in new (string?, string?, bool, bool)[]
            {
                (released, null, false, false),
                (released.Replace("\n", "\r\n"), null, false, false),
                (null, released, false, false),
                (released, released, false, false),
                ("Edited framework.", released, true, false),
                // The root file shadows an edited fallback; deleting it would activate the fallback.
                (released, "Edited fallback.", true, true),
                (null, "Edited fallback.", false, true),
            }
        )
        {
            using var temp = new TempDirectory();
            var agents = Catalog(temp);
            if (root is not null)
                await File.WriteAllTextAsync(agents.FrameworkSystemPath, root);
            if (fallback is not null)
                await File.WriteAllTextAsync(agents.MainFallbackSystemPath, fallback);
            await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
            Assert.Equal(rootKept, File.Exists(agents.FrameworkSystemPath));
            Assert.Equal(fallbackKept, File.Exists(agents.MainFallbackSystemPath));
            if (rootKept)
                Assert.Equal(root, await File.ReadAllTextAsync(agents.FrameworkSystemPath));
            if (fallbackKept)
                Assert.Equal(fallback, await File.ReadAllTextAsync(agents.MainFallbackSystemPath));
        }
    }

    [Fact]
    public async Task Bundled_base_is_followed_by_local_addition_unless_an_edited_copy_replaces_it()
    {
        using var temp = new TempDirectory();
        var agents = Catalog(temp);
        var template = Path.Combine(temp.Path, "template.md");
        await File.WriteAllTextAsync(template, "BUNDLED-BASE");
        await File.WriteAllTextAsync(
            agents.FrameworkLocalPath,
            "LOCAL-SHARED\n<foxwarm-if model-id=\"local/other\">\nLOCAL-OTHER\n</foxwarm-if>\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(agents.MemoryDirectory("main"), "MEMORY.md"),
            "AGENT-MEMORY"
        );
        var memory = new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills")),
            template
        );

        var prompt = await memory.BuildAsync("main", "main/main", "local/model");
        Assert.True(
            prompt.IndexOf("BUNDLED-BASE", StringComparison.Ordinal)
                < prompt.IndexOf("LOCAL-SHARED", StringComparison.Ordinal)
        );
        Assert.True(
            prompt.IndexOf("LOCAL-SHARED", StringComparison.Ordinal)
                < prompt.IndexOf("AGENT-MEMORY", StringComparison.Ordinal)
        );
        Assert.DoesNotContain("LOCAL-OTHER", prompt);

        await File.WriteAllTextAsync(agents.FrameworkSystemPath, "EDITED-REPLACEMENT");
        prompt = await memory.BuildAsync("main", "main/main", "local/model");
        Assert.Contains("EDITED-REPLACEMENT", prompt);
        Assert.DoesNotContain("BUNDLED-BASE", prompt);
        Assert.Contains("LOCAL-SHARED", prompt);
    }
}
