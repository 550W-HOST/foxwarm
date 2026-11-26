using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>
/// The bundled framework prompt carries text for runtimes with and without a master Node in
/// <c>master-node</c> conditions. Each profile renders exactly its own blocks, and every other
/// byte of the template, including the model and runtime conditions, renders as before.
/// </summary>
public sealed class FrameworkPromptProfileTests
{
    private static readonly string[] Models =
    [
        "anthropic/claude-opus-5-5",
        "550a/gpt-6.2-sol",
        "550a/gpt-6.1-terra",
        "local/model",
    ];

    private static Task<string> TemplateAsync() =>
        File.ReadAllTextAsync(
            Path.Combine(VectorFixture.Repository(), "templates", "agents", FrameworkPrompt.FileName)
        );

    // The template as a profile sees it: the other profile's blocks removed, its own unwrapped.
    private static string Profile(string template, bool masterNode)
    {
        var own = masterNode ? "true" : "false";
        var other = masterNode ? "false" : "true";
        var text = Regex.Replace(
            template,
            $"^<foxwarm-if master-node=\"{other}\">\\n(?:.*\\n)*?</foxwarm-if>\\n",
            "",
            RegexOptions.Multiline
        );
        return Regex.Replace(
            text,
            $"^<foxwarm-if master-node=\"{own}\">\\n((?:.*\\n)*?)</foxwarm-if>\\n",
            "$1",
            RegexOptions.Multiline
        );
    }

    [Fact]
    public async Task Each_profile_renders_only_its_own_blocks_and_the_rest_of_the_template_unchanged()
    {
        var template = await TemplateAsync();
        Assert.Contains("master-node=\"false\"", template);
        foreach (var model in Models)
        foreach (var runtime in new[] { ConditionalMemory.FoxwarmRuntime, ClaudeRuntimeState.Kind })
        foreach (var masterNode in new[] { true, false })
        {
            var rendered = ConditionalMemory.FilterConditionalMemorySource(
                template,
                model,
                runtime,
                masterNode
            );
            Assert.DoesNotContain("master-node", rendered);
            Assert.Equal(
                ConditionalMemory.FilterConditionalMemorySource(
                    Profile(template, masterNode),
                    model,
                    runtime
                ),
                rendered
            );
        }
        // Without the argument, a runtime has a master Node.
        Assert.Equal(
            ConditionalMemory.FilterConditionalMemorySource(template, Models[0], masterNode: true),
            ConditionalMemory.FilterConditionalMemorySource(template, Models[0])
        );
    }

    [Fact]
    public async Task Without_a_master_Node_the_prompt_names_no_Main_local_paths()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "agents"));
        var agents = new AgentCatalog(Path.Combine(temp.Path, "data"), work);
        Directory.CreateDirectory(agents.MemoryDirectory("main"));
        await File.WriteAllTextAsync(
            Path.Combine(agents.MemoryDirectory("main"), "MEMORY.md"),
            "AGENT-MEMORY\n<foxwarm-if master-node=\"false\">\nHOSTED-ONLY\n</foxwarm-if>\n"
        );
        var template = Path.Combine(temp.Path, "template.md");
        await File.WriteAllTextAsync(template, "BUNDLED-BASE");
        var skills = new Skills(agents, Path.Combine(temp.Path, "skills"));

        var file = await new AgentMemory(agents, skills, template).BuildAsync(
            "main",
            "main/main",
            "local/model"
        );
        Assert.Contains("; path=" + template + ">", file);
        Assert.Contains("--- DIRECTORIES ---\n- agent_folder: " + agents.AgentDirectory("main"), file);
        Assert.DoesNotContain("HOSTED-ONLY", file);

        var hosted = await new AgentMemory(agents, skills, template, masterNode: false).BuildAsync(
            "main",
            "main/main",
            "local/model"
        );
        Assert.Contains("<memory_file agent=framework; ownership=inherited>\nBUNDLED-BASE\n", hosted);
        Assert.Contains("<memory_file agent=main; ownership=self>\nAGENT-MEMORY\nHOSTED-ONLY\n", hosted);
        Assert.DoesNotContain("path=", hosted);
        Assert.DoesNotContain("DIRECTORIES", hosted);
        Assert.DoesNotContain(temp.Path, hosted);
        Assert.EndsWith("</memory_file>", hosted);
    }
}
