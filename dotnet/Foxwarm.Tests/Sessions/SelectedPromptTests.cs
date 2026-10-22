using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SelectedPromptTests
{
    [Fact]
    public async Task Isolated_selected_paths_keep_Source_normalization_and_symlink_semantics()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        await agents.CreateAsync("restricted");
        await agents.SetIsolationAsync("restricted", "synthetic-bound", true, null);
        var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills")));
        var directory = agents.AgentDirectory("restricted");
        var outside = Path.Combine(temp.Path, "outside.md");
        await File.WriteAllTextAsync(outside, "synthetic symlink marker");
        File.CreateSymbolicLink(Path.Combine(directory, "inside-link.md"), outside);
        var allowed = await memory.BuildAsync("restricted", "restricted/child", "a/wire", selection: ["inside-link.md"]);
        Assert.Contains("synthetic symlink marker", allowed);
        var outsideLink = Path.Combine(temp.Path, "outside-link.md");
        File.CreateSymbolicLink(outsideLink, Path.Combine(directory, "inside-link.md"));
        var error = await Assert.ThrowsAsync<InvalidDataException>(() => memory.BuildAsync("restricted", "restricted/child", "a/wire", selection: [outsideLink]));
        Assert.Contains("can only access agents/restricted/", error.Message);
        var empty = await memory.BuildAsync("restricted", "restricted/child", "a/wire", selection: []);
        Assert.DoesNotContain("synthetic symlink marker", empty);
    }

    [Fact]
    public async Task Explicit_selection_keeps_order_duplicates_and_session_model_conditions_with_ordinary_file_symlinks()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(data, work);
        var skills = new Skills(agents, Path.Combine(temp.Path, "skills"));
        var memory = new AgentMemory(agents, skills);
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(work, "memory", "default.md"),
            "default memory excluded"
        );
        await File.WriteAllTextAsync(
            Path.Combine(work, "first.md"),
            "---\ninclude-session: child\n---\nfirst selected\n<foxwarm-if model-id=\"a/wire\">\nmodel a only\n</foxwarm-if>\n"
        );
        var outside = Path.Combine(temp.Path, "external.md");
        await File.WriteAllTextAsync(outside, "second selected");
        File.CreateSymbolicLink(Path.Combine(work, "ordinary-link.md"), outside);
        var selected = AgentMemory.NormalizeSelection(
            JsonValue.Create(" first.md, #ignored line\nordinary-link.md,first.md ")
        )!;
        Assert.Equal(["first.md", "ordinary-link.md", "first.md"], selected);
        var child = await memory.BuildAsync("main", "child", "a/wire", selection: selected);
        Assert.DoesNotContain("default memory excluded", child);
        Assert.Contains("model a only", child);
        Assert.True(
            child.IndexOf("first selected", StringComparison.Ordinal)
                < child.IndexOf("second selected", StringComparison.Ordinal)
        );
        Assert.True(
            child.LastIndexOf("first selected", StringComparison.Ordinal)
                > child.IndexOf("second selected", StringComparison.Ordinal)
        );
        Assert.Contains("ownership=self", child);
        var other = await memory.BuildAsync("main", "parent", "b/wire", selection: selected);
        Assert.DoesNotContain("first selected", other);
        Assert.DoesNotContain("model a only", other);
        Assert.Contains("second selected", other);
    }

    [Fact]
    public async Task Omitted_selection_uses_default_memory_but_empty_selection_keeps_only_nonmemory_prompt_sections()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var agents = new AgentCatalog(data, work);
        var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills")));
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(work, "memory", "default.md"),
            "ordinary default memory"
        );
        var defaultPrompt = await memory.BuildAsync("main", "s", "a/wire");
        Assert.Contains("ordinary default memory", defaultPrompt);
        var empty = await memory.BuildAsync("main", "s", "a/wire", selection: []);
        Assert.DoesNotContain("ordinary default memory", empty);
        Assert.Contains("--- DIRECTORIES ---", empty);
        Assert.Contains("a/wire", empty);
        var envelope = new JsonObject { ["systemPromptFiles"] = " #only comments\n " };
        AgentMemory.NormalizePersistedSelection(envelope);
        Assert.Empty(envelope["systemPromptFiles"]!.AsArray());
        var array = AgentMemory.NormalizeSelection(
            new JsonArray(" #literal-filename ", 42, true, null, "first.md")
        );
        Assert.Equal(["#literal-filename", "first.md"], array);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            memory.BuildAsync("main", "s", "a/wire", selection: ["missing.md"])
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            memory.BuildAsync("main", "s", "a/wire", selection: ["memory"])
        );
    }
}
