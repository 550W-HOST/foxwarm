using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class AgentFilesTests
{
    // The composed prompt shows these locators, so they must stay the paths it showed before.
    [Fact]
    public async Task Locators_are_the_existing_prompt_paths()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        await agents.CreateAsync("child");
        var files = new FileAgentFiles(agents);
        Assert.Equal(agents.FrameworkSystemPath, files.Locator(null, FrameworkPrompt.FileName));
        Assert.Equal(agents.FrameworkLocalPath, files.Locator(null, FrameworkPrompt.LocalFileName));
        Assert.Equal(
            agents.MainFallbackSystemPath,
            files.Locator("main", "memory/" + FrameworkPrompt.FileName)
        );
        Assert.Equal(
            Path.Combine(agents.MemoryDirectory("child"), "MEMORY.md"),
            files.Locator("child", "memory/MEMORY.md")
        );
    }

    [Fact]
    public async Task Listings_report_links_without_reading_their_targets()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        await agents.CreateAsync("child");
        var memory = agents.MemoryDirectory("child");
        await File.WriteAllTextAsync(Path.Combine(memory, "A.md"), "a");
        File.CreateSymbolicLink(Path.Combine(memory, "dangling.md"), Path.Combine(temp.Path, "none"));
        Directory.CreateDirectory(Path.Combine(memory, "sub"));
        var files = new FileAgentFiles(agents);
        var all = files.List("child", "memory").ToDictionary(entry => entry.Name);
        Assert.True(all["dangling.md"].IsLink);
        Assert.Null(all["dangling.md"].Length);
        Assert.Equal(1, all["A.md"].Length);
        Assert.True(all["sub"].IsDirectory);
        var markdown = files.List("child", "memory", "*.md").Select(entry => entry.Name).Order();
        Assert.Contains("A.md", markdown);
        Assert.Contains("dangling.md", markdown);
        Assert.DoesNotContain("sub", markdown);
        Assert.Empty(files.List("child", "missing"));
    }
}
