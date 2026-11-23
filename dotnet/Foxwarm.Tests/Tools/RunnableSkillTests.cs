using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Runnable skills: the `run` frontmatter block, entry containment, resolution, the catalog
// marking and the `skill run` command form. Copy is checked as data, never as wording.
public sealed class RunnableSkillTests
{
    private const string Valid =
        "run:\n  entry: scripts/run.py\n  effect: Does one bounded thing.\n";

    internal static string WriteSkill(
        string root,
        string name,
        string frontmatter,
        string? entry = "scripts/run.py",
        string code = "return 1\n",
        string description = "A synthetic skill."
    )
    {
        var directory = Path.Combine(root, name);
        Directory.CreateDirectory(directory);
        File.WriteAllText(
            Path.Combine(directory, "SKILL.md"),
            $"---\nname: {name}\ndescription: {description}\n{frontmatter}---\n\n# {name}\n"
        );
        if (entry is not null)
        {
            var path = Path.Combine(directory, entry);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, code);
        }
        return directory;
    }

    private sealed class Catalog : IDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal readonly AgentCatalog Agents;
        internal readonly Skills Skills;
        internal string Global => Path.Combine(Temp.Path, "skills");
        internal string Work => Path.Combine(Temp.Path, "work");

        internal Catalog()
        {
            Directory.CreateDirectory(Work);
            Directory.CreateDirectory(Global);
            Agents = new AgentCatalog(Path.Combine(Temp.Path, "data"), Work);
            Skills = new Skills(Agents, Global);
        }

        internal string Local(string agent) =>
            Path.Combine(Agents.SourceDirectory(agent), "skills");

        public void Dispose() => Temp.Dispose();
    }

    [Fact]
    public async Task A_valid_run_block_gives_entry_effect_mode_budget_and_a_typed_schema()
    {
        using var c = new Catalog();
        WriteSkill(
            c.Global,
            "demo",
            "run:\n  entry: scripts/run.py\n  effect: Runs the demo.\n  mode: background\n  timeoutSecs: 12.5\n  args:\n    type: object\n    additionalProperties: false\n    required: [question]\n    properties:\n      question: {type: string, description: What to ask.}\n      level: {type: integer, enum: [1, 2]}\n      tags: {type: array, items: {type: string}}\n"
        );
        WriteSkill(c.Global, "minimal", Valid);
        var list = await c.Skills.ListAsync("main");
        var demo = list.Single(skill => skill.Name == "demo").Run!;
        Assert.Equal(("scripts/run.py", "Runs the demo.", "background", 12.5), (demo.Entry, demo.Effect, demo.Mode, demo.TimeoutSecs));
        Assert.True(
            JsonNode.DeepEquals(
                JsonNode.Parse(
                    """{"type":"object","additionalProperties":false,"required":["question"],"properties":{"question":{"type":"string","description":"What to ask."},"level":{"type":"integer","enum":[1,2]},"tags":{"type":"array","items":{"type":"string"}}}}"""
                ),
                demo.Args
            ),
            demo.Args.ToJsonString()
        );
        var minimal = list.Single(skill => skill.Name == "minimal").Run!;
        Assert.Equal(("foreground", (double?)null), (minimal.Mode, minimal.TimeoutSecs));
        // Without args the entry takes none.
        Assert.Throws<InvalidDataException>(() =>
            Skills.ValidateArgs(minimal.Args, new JsonObject { ["x"] = 1 })
        );
        Skills.ValidateArgs(minimal.Args, new JsonObject());
    }

    [Theory]
    [InlineData("run: scripts/run.py\n")]
    [InlineData("run:\n  effect: No entry.\n")]
    [InlineData("run:\n  entry: scripts/run.py\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: \"two\\nlines\"\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  mode: later\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  timeoutSecs: -1\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  extra: 1\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  args: {type: string}\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  args: {type: object, default: {}}\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  args: {type: object, required: [q]}\n")]
    [InlineData("run:\n  entry: scripts/run.py\n  effect: Fine.\n  args: {type: object, properties: {n: {type: integer, enum: [x]}}}\n")]
    [InlineData("run:\n  entry: ../run.py\n  effect: Fine.\n")]
    [InlineData("run:\n  entry: scripts/../scripts/run.py\n  effect: Fine.\n")]
    [InlineData("run:\n  entry: /etc/passwd\n  effect: Fine.\n")]
    [InlineData("run:\n  entry: scripts\\run.py\n  effect: Fine.\n")]
    [InlineData("run:\n  entry: scripts/missing.py\n  effect: Fine.\n")]
    [InlineData("run:\n  entry: scripts\n  effect: Fine.\n")]
    public async Task An_invalid_run_block_leaves_the_skill_loadable_but_not_runnable(string block)
    {
        using var c = new Catalog();
        WriteSkill(c.Global, "broken", block);
        var info = Assert.Single(await c.Skills.ListAsync("main"));
        Assert.Null(info.Run);
        Assert.NotNull(info.RunError);
        var (loaded, content) = await c.Skills.LoadAsync("broken", "main");
        Assert.Equal("A synthetic skill.", loaded.Description);
        Assert.Contains("# broken", content);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            c.Skills.ReadEntryAsync("broken", "main")
        );
        Assert.Contains("`run`", error.Message);
        Assert.Contains(info.RunError!, error.Message);
    }

    [Fact]
    public async Task An_overlong_effect_is_rejected_at_the_limit()
    {
        using var c = new Catalog();
        WriteSkill(c.Global, "edge", $"run:\n  entry: scripts/run.py\n  effect: {new string('e', Skills.MaxEffectLength)}\n");
        WriteSkill(c.Global, "over", $"run:\n  entry: scripts/run.py\n  effect: {new string('e', Skills.MaxEffectLength + 1)}\n");
        var list = await c.Skills.ListAsync("main");
        Assert.NotNull(list.Single(skill => skill.Name == "edge").Run);
        Assert.Null(list.Single(skill => skill.Name == "over").Run);
    }

    [Fact]
    public async Task Entry_reads_reject_links_and_invalid_UTF8_and_hash_the_exact_bytes()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var c = new Catalog();
        var outside = Path.Combine(c.Temp.Path, "outside.py");
        await File.WriteAllTextAsync(outside, "return 'outside'\n");
        var linked = WriteSkill(c.Global, "linked", Valid, entry: null);
        Directory.CreateDirectory(Path.Combine(linked, "scripts"));
        File.CreateSymbolicLink(Path.Combine(linked, "scripts", "run.py"), outside);
        var parent = WriteSkill(c.Global, "parentlink", Valid, entry: null);
        var real = Path.Combine(c.Temp.Path, "real-scripts");
        Directory.CreateDirectory(real);
        await File.WriteAllTextAsync(Path.Combine(real, "run.py"), "return 2\n");
        Directory.CreateSymbolicLink(Path.Combine(parent, "scripts"), real);
        var bytes = WriteSkill(c.Global, "bytes", Valid, entry: null);
        Directory.CreateDirectory(Path.Combine(bytes, "scripts"));
        await File.WriteAllBytesAsync(Path.Combine(bytes, "scripts", "run.py"), [0x72, 0xff, 0x0a]);
        var good = WriteSkill(c.Global, "good", Valid, code: "\uFEFFreturn 'é'\n");

        var list = await c.Skills.ListAsync("main");
        Assert.Null(list.Single(skill => skill.Name == "linked").Run);
        Assert.Null(list.Single(skill => skill.Name == "parentlink").Run);
        var utf8 = await Assert.ThrowsAsync<InvalidDataException>(() =>
            c.Skills.ReadEntryAsync("bytes", "main")
        );
        Assert.Contains("UTF-8", utf8.Message);
        var entry = await c.Skills.ReadEntryAsync("good", "main");
        Assert.Equal("return 'é'\n", entry.Code);
        Assert.Equal(
            Convert.ToHexStringLower(
                SHA256.HashData(await File.ReadAllBytesAsync(Path.Combine(good, "scripts", "run.py")))
            ),
            entry.Sha256
        );
        var provenance = entry.Provenance();
        Assert.Equal("good", provenance["name"]!.GetValue<string>());
        Assert.Equal("global", provenance["sourceType"]!.GetValue<string>());
        Assert.Equal("scripts/run.py", provenance["entry"]!.GetValue<string>());
    }

    [Fact]
    public async Task Resolution_is_the_first_match_of_load_and_nested_skills_are_not_runnable()
    {
        using var c = new Catalog();
        await c.Agents.CreateAsync("base");
        await c.Agents.CreateAsync("worker");
        await c.Agents.SetInheritableAsync("base", true);
        await c.Agents.SetInheritAsync("worker", "base");
        WriteSkill(c.Global, "shadowed", Valid, code: "return 'global'\n");
        WriteSkill(c.Local("worker"), "shadowed", "", entry: null);
        WriteSkill(c.Global, "inherited", Valid, code: "return 'global'\n");
        WriteSkill(c.Local("base"), "inherited", Valid, code: "return 'base'\n");
        var outer = WriteSkill(c.Global, "outer", Valid);
        WriteSkill(outer, "inner", Valid);
        WriteSkill(c.Global, "plain", "", entry: null);

        // A local skill without `run` shadows a runnable global one of the same name.
        var shadow = await Assert.ThrowsAsync<InvalidDataException>(() =>
            c.Skills.ReadEntryAsync("shadowed", "worker")
        );
        Assert.Contains("ctl skill load shadowed", shadow.Message);
        Assert.Equal("return 'global'\n", (await c.Skills.ReadEntryAsync("shadowed", "main")).Code);
        var inherited = await c.Skills.ReadEntryAsync("inherited", "worker");
        Assert.Equal(("return 'base'\n", "agent-inherited", "base"), (inherited.Code, inherited.Info.SourceType, inherited.Info.SourceAgent));
        Assert.Equal("return 'global'\n", (await c.Skills.ReadEntryAsync("inherited", "main")).Code);
        var nested = await Assert.ThrowsAsync<InvalidDataException>(() =>
            c.Skills.ReadEntryAsync("outer/inner", "main")
        );
        Assert.Contains("inside skill 'outer'", nested.Message);
        var plain = await Assert.ThrowsAsync<InvalidDataException>(() =>
            c.Skills.ReadEntryAsync("plain", "main")
        );
        Assert.Contains("ctl skill load plain", plain.Message);
        await Assert.ThrowsAsync<InvalidDataException>(() => c.Skills.ReadEntryAsync("absent", "main"));
        // Skills without `run` keep their listing and load output.
        var listed = await c.Skills.ListAsync("main");
        Assert.All(listed.Where(skill => skill.Name is "plain"), skill => Assert.Null(skill.RunError));
    }

    [Fact]
    public void Arguments_are_checked_against_the_schema_and_errors_name_the_field()
    {
        using var temp = new TempDirectory();
        var schema = Skills.ParseRun(
            new Dictionary<object, object> { ["entry"] = "x.py", ["effect"] = "e" },
            WriteEntry(temp.Path)
        ).Args;
        Assert.Empty(schema["properties"]!.AsObject());
        var typed = JsonNode.Parse(
            """{"type":"object","additionalProperties":false,"required":["question"],"properties":{"question":{"type":"string"},"effort":{"type":"string","enum":["low","high"]},"wait":{"type":"integer"},"tags":{"type":"array","items":{"type":"string"}},"opts":{"type":"object","properties":{"deep":{"type":"boolean"}}}}}"""
        )!.AsObject();
        Skills.ValidateArgs(typed, JsonNode.Parse("""{"question":"q","effort":"low","wait":3,"tags":["a"],"opts":{"deep":true}}"""));
        // Values built in code rather than parsed (as ToolScript and ctl bind them).
        Skills.ValidateArgs(typed, new JsonObject { ["question"] = "q", ["wait"] = 3, ["tags"] = new JsonArray("a") });
        Assert.Throws<InvalidDataException>(() => Skills.ValidateArgs(typed, new JsonObject { ["question"] = "q", ["wait"] = 2.5 }));
        foreach (
            var (args, field) in new[]
            {
                ("{}", "args.question"),
                ("""{"question":1}""", "args.question"),
                ("""{"question":"q","effort":"max"}""", "args.effort"),
                ("""{"question":"q","wait":1.5}""", "args.wait"),
                ("""{"question":"q","tags":[1]}""", "args.tags[0]"),
                ("""{"question":"q","opts":{"deep":"yes"}}""", "args.opts.deep"),
                ("""{"question":"q","other":1}""", "args.other"),
                ("[]", "args"),
            }
        )
        {
            var error = Assert.Throws<InvalidDataException>(() =>
                Skills.ValidateArgs(typed, JsonNode.Parse(args))
            );
            Assert.Contains("`" + field + "`", error.Message);
        }
    }

    private static string WriteEntry(string directory)
    {
        File.WriteAllText(Path.Combine(directory, "x.py"), "return 1\n");
        return directory;
    }

    private static async Task<string> Snapshot(Catalog c) =>
        await new AgentMemory(c.Agents, c.Skills).BuildAsync("main", "main/s", "a/wire");

    // Today's catalog text for skills without `run`; a change here changes every Session's prompt.
    private const string PlainCatalog =
        "The following skills provide specialized instructions for specific tasks.\nWhen a task matches a skill's description, run `ctl skill load <name>`\nto load its full instructions and resource list.\nRead listed resources only when the loaded skill or current task needs them:\n<available_skills>\n  <skill><name>broken</name><description>A synthetic skill.</description><source>global</source></skill>\n  <skill><name>plain</name><description>Plain &amp; &lt;simple&gt;.</description><source>global</source></skill>\n</available_skills>\n";

    [Fact]
    public async Task A_catalog_without_a_runnable_skill_keeps_its_exact_bytes()
    {
        using var c = new Catalog();
        WriteSkill(c.Global, "plain", "", entry: null, description: "\"Plain & <simple>.\"");
        // An invalid run block is not listed as runnable.
        WriteSkill(c.Global, "broken", "run:\n  entry: scripts/missing.py\n  effect: Never shown.\n", entry: null);
        var snapshot = await Snapshot(c);
        Assert.Contains("\n\n" + PlainCatalog + "\n--- DIRECTORIES ---", snapshot);
        Assert.DoesNotContain("<run>", snapshot);
        Assert.DoesNotContain(AgentMemory.RunnableSkillsSentence, snapshot);
    }

    [Fact]
    public async Task A_runnable_skill_adds_one_sentence_and_an_escaped_run_element()
    {
        using var c = new Catalog();
        WriteSkill(c.Global, "plain", "", entry: null);
        WriteSkill(c.Global, "runner", "run:\n  entry: scripts/run.py\n  effect: \"Checks <a> & <b>.\"\n");
        WriteSkill(c.Global, "second", "run:\n  entry: scripts/run.py\n  effect: Second effect.\n");
        var snapshot = await Snapshot(c);
        var sentence = snapshot.IndexOf(AgentMemory.RunnableSkillsSentence, StringComparison.Ordinal);
        Assert.True(sentence > 0);
        Assert.Equal(sentence, snapshot.LastIndexOf(AgentMemory.RunnableSkillsSentence, StringComparison.Ordinal));
        // After the load sentence, before the line that introduces the list.
        Assert.True(snapshot.IndexOf("to load its full instructions and resource list.\n", StringComparison.Ordinal) < sentence);
        Assert.True(sentence < snapshot.IndexOf("Read listed resources only", StringComparison.Ordinal));
        Assert.Contains(
            "<skill><name>runner</name><description>A synthetic skill.</description><source>global</source><run>Checks &lt;a&gt; &amp; &lt;b&gt;.</run></skill>\n",
            snapshot
        );
        Assert.Contains("<run>Second effect.</run>", snapshot);
        Assert.Contains("<skill><name>plain</name><description>A synthetic skill.</description><source>global</source></skill>\n", snapshot);
        // Without the runnable skills the catalog returns to the plain form.
        Directory.Delete(Path.Combine(c.Global, "runner"), true);
        Directory.Delete(Path.Combine(c.Global, "second"), true);
        Assert.DoesNotContain(AgentMemory.RunnableSkillsSentence, await Snapshot(c));
    }

    [Fact]
    public async Task Bundled_run_blocks_are_valid_and_the_advisor_takes_a_required_question()
    {
        using var c = new Catalog();
        var skills = new Skills(c.Agents, Path.Combine(AppContext.BaseDirectory, "skills"));
        var list = await skills.ListAsync("main");
        Assert.All(list, skill => Assert.Null(skill.RunError));
        var advisor = list.Single(skill => skill.Name == "advisor").Run!;
        Assert.Equal("foreground", advisor.Mode);
        Assert.Equal("question", Assert.Single(advisor.Args["required"]!.AsArray())!.GetValue<string>());
        Assert.False(advisor.Args["additionalProperties"]!.GetValue<bool>());
        Skills.ValidateArgs(advisor.Args, new JsonObject { ["question"] = "q", ["model"] = "m", ["effort"] = "high", ["waitSeconds"] = 60 });
        var entry = await skills.ReadEntryAsync("advisor", "main");
        Assert.Equal("global", entry.Info.SourceType);
    }

    [Fact]
    public void Skill_run_parses_as_run_skill_and_its_help_names_the_skill()
    {
        static JsonObject Args(string command, JsonObject? values = null, string? valuesJson = null)
        {
            var args = new JsonObject { ["command"] = command };
            if (values is not null)
                args["values"] = values;
            if (valuesJson is not null)
                args["valuesJson"] = valuesJson;
            return args;
        }
        var bound = Assert.IsType<CtlTarget>(
            CtlParser.Parse(Args("skill run demo --args @a", valuesJson: """{"a":{"n":1}}"""))
        );
        Assert.Equal(("builtin", "run_skill"), (bound.Source, bound.Name));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"skillName":"demo","args":{"n":1}}"""), bound.Args));
        // --args takes an object, never text.
        Assert.IsType<CtlError>(CtlParser.Parse(Args("skill run demo --args @a", new JsonObject { ["a"] = "text" })));
        Assert.IsType<CtlError>(CtlParser.Parse(Args("skill run demo --mode later")));
        Assert.IsType<CtlError>(CtlParser.Parse(Args("skill run")));
        var help = Assert.IsType<CtlSkillHelp>(CtlParser.Parse(Args("skill run demo --agent-name other --help")));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"skillName":"demo","agentName":"other"}"""), help.Args));
        Assert.IsType<CtlHelpRequest>(CtlParser.Parse(Args("skill run --help")));
        // Help, discovery and the display name treat it like any command.
        Assert.Equal("skill run", CtlParser.DisplayName(Args("skill run demo")));
        Assert.Equal("ctl", CtlParser.DisplayName(Args("skill run demo --help")));
        Assert.Equal("skill run", Assert.Single(CtlRegistry.ForTarget("builtin", "run_skill")).Path);
        Assert.DoesNotContain("run_skill", SessionToolExecutor.DefaultBuiltins);
    }
}
