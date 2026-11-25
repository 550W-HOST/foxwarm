using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Tests;

// `skill copy` writes skill files to a Node under that Node's write rules; `skill run --script`
// runs another ToolScript file of a skill like its entry.
public sealed partial class SkillAccessTests
{
    private static string Sha(string path) =>
        Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));

    private static JsonObject[] Copied(JsonObject result)
    {
        Assert.True(result["files"] is JsonArray, result.ToJsonString());
        return result["files"]!.AsArray().Select(item => item!.AsObject()).ToArray();
    }

    [Fact]
    public async Task Copies_keep_the_layout_and_hashes_of_files_directories_and_whole_skills()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/a.md", "a\n");
        Put(demo, "references/sub/b.md", "b\n");
        Put(demo, ".git/config", "[remote]\n");
        Put(demo, "references/node_modules/x.js", "x\n");
        Directory.CreateDirectory(Path.Combine(demo, "empty"));
        var owner = await host.Agent("copier", null);
        var output = Path.Combine(host.F.Work, "out");

        var whole = await host.Ctl(owner, $"skill copy demo {output}/whole");
        Assert.Equal("demo", SessionWait.Text(whole["skill"]));
        Assert.Equal("master", SessionWait.Text(whole["node"]));
        var files = Copied(whole);
        Assert.Equal(
            ["SKILL.md", "references/a.md", "references/sub/b.md", "scripts/run.py"],
            files.Select(file => SessionWait.Text(file["path"])).Order(StringComparer.Ordinal)
        );
        foreach (var file in files)
        {
            var relative = SessionWait.Text(file["path"])!;
            Assert.Equal(Sha(Path.Combine(demo, relative)), SessionWait.Text(file["sha256"]));
            Assert.Equal(
                await File.ReadAllTextAsync(Path.Combine(demo, relative)),
                await File.ReadAllTextAsync(Path.Combine(output, "whole", relative))
            );
        }
        Assert.Equal(files.Sum(file => file["bytes"]!.GetValue<long>()), whole["totalBytes"]!.GetValue<long>());
        Assert.False(Directory.Exists(Path.Combine(output, "whole", ".git")));
        Assert.False(Directory.Exists(Path.Combine(output, "whole", "empty")));
        Assert.False(Directory.Exists(Path.Combine(output, "whole", "references", "node_modules")));

        // A file goes to targetPath itself; a directory keeps its layout below targetPath.
        Assert.Single(Copied(await host.Ctl(owner, $"skill copy demo {output}/one.md --path references/a.md")));
        Assert.Equal("a\n", await File.ReadAllTextAsync(Path.Combine(output, "one.md")));
        foreach (var path in new[] { "references", "references/" })
        {
            var tree = Path.Combine(output, "tree-" + path.Length);
            Assert.Equal(2, Copied(await host.Ctl(owner, $"skill copy demo {tree} --path {path}")).Length);
            Assert.Equal("b\n", await File.ReadAllTextAsync(Path.Combine(tree, "sub", "b.md")));
        }

        // An existing file fails that file unless overwrite is given.
        Put(demo, "references/a.md", "changed\n");
        var kept = Copied(await host.Ctl(owner, $"skill copy demo {output}/one.md --path references/a.md")).Single();
        Assert.NotNull(kept["error"]);
        Assert.Equal("a\n", await File.ReadAllTextAsync(Path.Combine(output, "one.md")));
        var replaced = Copied(
            await host.Ctl(owner, $"skill copy demo {output}/one.md --path references/a.md --overwrite")
        ).Single();
        Assert.Null(replaced["error"]);
        Assert.Equal("changed\n", await File.ReadAllTextAsync(Path.Combine(output, "one.md")));

        // Sources are contained as resources are.
        foreach (var path in new[] { "../demo/SKILL.md", ".git/config", "empty" })
        {
            Assert.Contains(
                "is not a resource of skill `demo`",
                Error(await host.Ctl(owner, $"skill copy demo {output}/bad --path {path}"))
            );
            Assert.False(File.Exists(Path.Combine(output, "bad")));
        }
    }

    [Fact]
    public async Task A_copy_over_its_bounds_fails_before_writing_anything()
    {
        await using var host = await Host.Create();
        var many = host.Write("many");
        for (var index = 0; index < Skills.MaxCopyFiles; index++)
            Put(many, $"data/f{index:D3}.txt", "x\n");
        var owner = await host.Agent("copier", null);
        var target = Path.Combine(host.F.Work, "many");
        Assert.Contains($"{Skills.MaxCopyFiles} files", Error(await host.Ctl(owner, $"skill copy many {target}")));
        Assert.False(Directory.Exists(target));
        // A subdirectory within the bounds copies; a model sees the first 50 files.
        var copied = await host.Ctl(owner, $"skill copy many {target} --path data");
        Assert.Equal(50, Copied(copied).Length);
        Assert.Equal(Skills.MaxCopyFiles - 50, copied["moreFiles"]!.GetValue<int>());
        Assert.Equal(Skills.MaxCopyFiles, Directory.GetFiles(target).Length);
    }

    [Fact]
    public async Task A_template_worker_copy_to_master_is_denied_before_any_file_is_written()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/a.md");
        var worker = await host.Agent("worker", RestrictedWorkerRules());
        var target = Path.Combine(host.F.Work, "worker-copy");
        // The template allows the copy itself but denies every write on master.
        var denied = await host.Ctl(worker, $"skill copy demo {target}");
        Assert.Equal("tool_authorization_denied", denied.FailureCode());
        Assert.Contains("no-master", denied.ToJsonString());
        Assert.False(Directory.Exists(target));
    }

    [Fact]
    public async Task The_load_header_names_copy_and_script_runs_only_when_the_rules_may_allow_them()
    {
        await using var host = await Host.Create();
        host.Write("demo");
        const string read = "Read a resource with `ctl skill load demo <path>`";
        const string copy = "copy files to a Node with `ctl skill copy demo <target-path> --path <path>`";
        const string run = "run a ToolScript file with `ctl skill run demo --script <path>`";
        async Task<string> Header(SessionOwner owner, string command = "skill load demo") =>
            Output(await host.Ctl(owner, command));
        Assert.Contains($"{read}, {copy} and {run}.\n", await Header(await host.Agent("free", null)));
        Assert.Contains($"{read} and {copy}.\n", await Header(await host.Agent("assistant", ChannelAssistantRules())));
        var loadOnly = await host.Agent(
            "reader",
            Rules(
                """[{"id":"load","tool":{"source":"builtin","name":"skill"},"args":{"action":["list","load"]},"action":"allow"},{"id":"rest","action":"deny"}]"""
            )
        );
        Assert.Contains($"{read}.\n", await Header(loadOnly));
        static string Named(string clause) => clause.Replace("<path>`", "<path> --agent-name main`");
        Assert.Contains(
            $"{Named(read)}, {Named(copy)} and {Named(run)}.\n",
            await Header(await host.Agent("other", null), "skill load demo --agent-name main")
        );
    }

    private static Task<JsonObject> RunCommand(Host host, SessionOwner owner, string command, JsonObject? args = null) =>
        host.Ctl(owner, command, args is null ? null : new JsonObject { ["a"] = args });

    [Fact]
    public async Task A_script_runs_without_a_run_block_unchecked_and_records_which_file_ran()
    {
        if (!(OperatingSystem.IsLinux() && MontyWorker.IsSupported))
            return;
        await using var host = await Host.Create();
        var plain = host.Write("plain", "", entry: null);
        var script = Put(plain, "scripts/echo.py", "return {'got': args}\n");
        var demo = host.Write(
            "demo",
            "run:\n  entry: scripts/run.py\n  effect: Returns one.\n  args:\n    type: object\n    additionalProperties: false\n"
        );
        Put(demo, "scripts/other.py", "return 'other'\n");
        var owner = await host.Agent("runner", null);

        var result = await RunCommand(
            host,
            owner,
            "skill run plain --script scripts/echo.py --args @a",
            new JsonObject { ["any"] = 1 }
        );
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        Assert.Equal(1, result["result"]!["got"]!["any"]!.GetValue<int>());
        var record = await host.F.Manager.ToolScript.Store.ReadAsync(SessionWait.Text(result["runId"])!, default);
        var provenance = record!["sourceSkill"]!.AsObject();
        Assert.Equal("scripts/echo.py", SessionWait.Text(provenance["script"]));
        Assert.Null(provenance["entry"]);
        Assert.Equal(Sha(script), SessionWait.Text(provenance["sha256"]));

        // The entry's schema checks only the entry.
        Assert.Contains(
            "Invalid arguments",
            Error(await RunCommand(host, owner, "skill run demo --args @a", new JsonObject { ["x"] = 1 }))
        );
        var other = await RunCommand(
            host,
            owner,
            "skill run demo --script scripts/other.py --args @a",
            new JsonObject { ["x"] = 1 }
        );
        Assert.True(SessionWait.Text(other["status"]) == "completed", other.ToJsonString());
        Assert.Equal("other", SessionWait.Text(other["result"]));

        // Scripts are contained as resources are; directories are not scripts.
        foreach (var path in new[] { "../demo/scripts/run.py", "scripts", ".git/hook.py" })
            Assert.Contains(
                "is not a resource of skill `plain`",
                Error(await RunCommand(host, owner, $"skill run plain --script {path}"))
            );

        // A rule can allow the entry only.
        var entryOnly = await host.Agent(
            "entry-only",
            Rules(
                """[{"id":"scripts","tool":{"source":"builtin","name":"run_skill"},"args":{"script":{"exists":true}},"action":"deny"}]"""
            )
        );
        Assert.True(SessionWait.Text((await RunCommand(host, entryOnly, "skill run demo"))["status"]) == "completed");
        Assert.Equal(
            "tool_authorization_denied",
            (await RunCommand(host, entryOnly, "skill run demo --script scripts/other.py")).FailureCode()
        );
    }
}
