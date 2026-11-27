using System.Text;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The bundled skills per profile (P2 plan §10): a global skill document's <c>master-node</c>
/// wrappers are filtered when it is read, the master-only skills are absent without a master
/// Node, and the file-mode text of every document is the one it had before it was conditioned.
/// </summary>
public sealed class BundledSkillProfileTests
{
    private static readonly string Bundled = Path.Combine(AppContext.BaseDirectory, "skills");

    // A line-based reading of the bundled convention, independent of ConditionalMemory: a
    // `master-node="true"` block holds the file-mode lines and the `false` block after it the
    // hosted ones; wrappers are never nested and never inside a fence.
    private static string Reference(string text, bool masterNode)
    {
        var output = new List<string>();
        string? block = null;
        foreach (var line in text.Split('\n'))
        {
            if (block is null && line is "<foxwarm-if master-node=\"true\">" or "<foxwarm-if master-node=\"false\">")
            {
                block = line.Contains("true") ? "true" : "false";
                continue;
            }
            if (block is not null && line == "</foxwarm-if>")
            {
                block = null;
                continue;
            }
            if (block is null || block == (masterNode ? "true" : "false"))
                output.Add(line);
        }
        Assert.Null(block);
        return string.Join('\n', output);
    }

    private static AgentCatalog Catalog(TempDirectory temp)
    {
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "agents"));
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        Directory.CreateDirectory(agents.MemoryDirectory("main"));
        return agents;
    }

    private static IEnumerable<string> Documents(SkillInfo info) =>
        new[] { "SKILL.md" }.Concat(
            Skills.Resources(info.Source, info.Directory).Files.Where(path => path.EndsWith(".md", StringComparison.Ordinal))
        );

    [Fact]
    public async Task Every_bundled_document_reads_without_wrappers_and_keeps_its_file_mode_text()
    {
        using var temp = new TempDirectory();
        var agents = Catalog(temp);
        var file = new Skills(agents, Bundled);
        var hosted = new Skills(agents, Bundled, masterNode: false);
        var conditioned = new List<string>();
        foreach (var info in await file.ListAsync("main"))
        {
            Assert.Equal("global", info.SourceType);
            foreach (var path in Documents(info))
            {
                var raw = await File.ReadAllTextAsync(Path.Combine(info.Directory, path));
                var fileText = file.Text(info, path, raw);
                var hostedText = hosted.Text(info, path, raw);
                Assert.DoesNotContain("<foxwarm-if", fileText);
                Assert.DoesNotContain("<foxwarm-if", hostedText);
                Assert.Equal(Reference(raw, masterNode: true), fileText);
                Assert.Equal(Reference(raw, masterNode: false), hostedText);
                Assert.Equal(
                    Encoding.UTF8.GetBytes(fileText),
                    file.Bytes(info, path, await File.ReadAllBytesAsync(Path.Combine(info.Directory, path)))
                );
                if (raw.Contains("<foxwarm-if", StringComparison.Ordinal))
                    conditioned.Add(info.Name + "/" + path);
                else
                    Assert.Same(raw, hostedText);
            }
        }
        // The documents batch 4 conditioned; a new one is a deliberate change to this list.
        Assert.Equal(
            [
                "about-foxwarm/SKILL.md",
                "access-control/SKILL.md",
                "access-control/references/identities.md",
                "access-control/references/policy-updates.md",
                "agent-management/references/OPERATIONS.md",
                "mcp-management/references/outbound.md",
                "node-setup/SKILL.md",
                "timer-automation/SKILL.md",
                "webui-markers/SKILL.md",
            ],
            conditioned.Order(StringComparer.Ordinal).ToArray()
        );
        // The loaded document is the filtered one.
        var (_, loaded) = await hosted.LoadAsync("webui-markers", "main");
        Assert.DoesNotContain("## Commit marker", loaded);
        Assert.Contains("Commit cards aren't available in this deployment.", loaded);
        Assert.Contains("## Commit marker", (await file.LoadAsync("webui-markers", "main")).Content);
    }

    [Fact]
    public async Task The_catalog_without_master_lists_the_same_skills_except_the_master_only_ones()
    {
        using var temp = new TempDirectory();
        var agents = Catalog(temp);
        var fileMemory = new AgentMemory(agents, new Skills(agents, Bundled));
        var hostedMemory = new AgentMemory(agents, new Skills(agents, Bundled, masterNode: false), masterNode: false);
        var filePrompt = await fileMemory.BuildAsync("main", "main/main", "local/model");
        var hostedPrompt = await hostedMemory.BuildAsync("main", "main/main", "local/model");
        static string CatalogText(string prompt) =>
            prompt[prompt.IndexOf("<available_skills>", StringComparison.Ordinal)..(prompt.IndexOf("</available_skills>", StringComparison.Ordinal) + "</available_skills>".Length)];
        var fileCatalog = CatalogText(filePrompt);
        var hostedCatalog = CatalogText(hostedPrompt);
        // Descriptions aren't conditioned: the hosted catalog is the file catalog's entries
        // without the master-only skills, byte for byte.
        var expected = fileCatalog;
        foreach (var hidden in new[] { "asr-service", "foxwarm-maintenance" })
        {
            var start = expected.IndexOf($"  <skill><name>{hidden}</name>", StringComparison.Ordinal);
            Assert.True(start >= 0, hidden);
            var end = expected.IndexOf("</skill>\n", start, StringComparison.Ordinal) + "</skill>\n".Length;
            expected = expected.Remove(start, end - start);
        }
        Assert.Equal(expected, hostedCatalog);
        Assert.Contains("<name>webui-markers</name>", hostedCatalog);
        await Assert.ThrowsAnyAsync<Exception>(() =>
            new Skills(agents, Bundled, masterNode: false).LoadAsync("asr-service", "main")
        );
    }

    [Fact]
    public async Task An_Agents_own_skill_is_never_filtered()
    {
        using var temp = new TempDirectory();
        var agents = Catalog(temp);
        var text = "---\nname: own\ndescription: Own.\n---\n<foxwarm-if master-node=\"false\">\nHOSTED\n</foxwarm-if>\n";
        var directory = Path.Combine(agents.SourceDirectory("main"), "skills", "own");
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "SKILL.md"), text);
        foreach (var masterNode in new[] { true, false })
        {
            var skills = new Skills(agents, Bundled, masterNode);
            var (info, content) = await skills.LoadAsync("own", "main");
            Assert.Equal("agent-local", info.SourceType);
            Assert.Contains("<foxwarm-if master-node=\"false\">", content);
        }
    }

    // The master-side development workflow isn't offered without a master Node: its document and
    // script are left out of the listing and refused as reads, copies and script runs.
    [Fact]
    public async Task The_development_workflow_resources_are_withheld_without_master()
    {
        using var temp = new TempDirectory();
        var agents = Catalog(temp);
        string[] withheld = ["references/development-workflow.md", "examples/development_workflow.py"];
        foreach (var masterNode in new[] { true, false })
        {
            var skills = new Skills(agents, Bundled, masterNode);
            var (info, _) = await skills.LoadAsync("node-setup", "main");
            var copied = Skills.CopyPlan(info, null, "/target").Select(file => file.Path).ToArray();
            foreach (var path in withheld)
            {
                Assert.Equal(masterNode, info.Resources.Contains(path));
                Assert.Equal(masterNode, copied.Contains(path));
                if (masterNode)
                    Assert.False(Skills.ResourcePath(info, path).IsDirectory);
                else
                    Assert.Equal(
                        $"`{path}` is not a resource of skill `node-setup`.",
                        Assert.Throws<InvalidDataException>(() => Skills.ResourcePath(info, path)).Message
                    );
            }
            // `references/` holds only the workflow, so without master it isn't a resource either.
            if (masterNode)
                Assert.Contains("references/development-workflow.md", Skills.ResourcePath(info, "references/").Files);
            else
                Assert.Throws<InvalidDataException>(() => Skills.ResourcePath(info, "references/"));
            if (masterNode)
                Assert.NotNull(await skills.ReadScriptAsync("node-setup", "main", "examples/development_workflow.py"));
            else
                await Assert.ThrowsAsync<InvalidDataException>(() =>
                    skills.ReadScriptAsync("node-setup", "main", "examples/development_workflow.py")
                );
            // Other resources stay.
            Assert.Contains("examples/container/README.md", info.Resources);
        }
    }
}
