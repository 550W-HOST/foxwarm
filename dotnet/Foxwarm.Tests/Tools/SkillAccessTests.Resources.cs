using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Tests;

// `skill load <name> <path>`: resources are read through the skill subsystem, contained like the
// run entry, formatted like `read`, and authorized by the `skill` rule alone.
public sealed partial class SkillAccessTests
{
    private const string Png1x1 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    private static string Put(string directory, string relative, string content = "body\n")
    {
        var path = Path.Combine(directory, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    private static string Output(JsonObject result) =>
        SessionWait.Text(result["output"]) ?? throw new Xunit.Sdk.XunitException(result.ToJsonString());

    private static string Error(JsonObject result) =>
        SessionWait.Text(result["error"]) ?? throw new Xunit.Sdk.XunitException(result.ToJsonString());

    [Fact]
    public async Task Resource_paths_are_contained_and_every_refusal_reads_the_same()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/guide.md", "guide\n");
        Put(demo, ".git/config", "[remote] url = https://token@example.invalid/x\n");
        Put(demo, "node_modules/pkg/index.js");
        Put(demo, "build/out.txt");
        Put(demo, "nested/SKILL.md", "---\ndescription: nested\n---\n");
        Put(demo, "nested/notes.md", "nested notes\n");
        var outside = Put(host.F.Work, "outside.txt", "outside\n");
        File.CreateSymbolicLink(Path.Combine(demo, "linked.txt"), outside);
        Directory.CreateDirectory(Path.Combine(host.F.Work, "outside-dir"));
        Put(host.F.Work, "outside-dir/x.md");
        Directory.CreateDirectory(Path.Combine(demo, "empty"));
        Directory.CreateSymbolicLink(Path.Combine(demo, "linked-dir"), Path.Combine(host.F.Work, "outside-dir"));
        for (var index = 0; index < 205; index++)
            Put(demo, $"many/{index:000}.txt", $"file {index}\n");
        var owner = await host.Agent("reader", null);
        foreach (
            var path in new[]
            {
                "../demo/SKILL.md",
                "references/../references/guide.md",
                "./references/guide.md",
                outside,
                "references\\guide.md",
                "c:references/guide.md",
                "references//guide.md",
                "linked.txt",
                "linked-dir/x.md",
                "linked-dir/",
                ".git/config",
                "node_modules/pkg/index.js",
                "build/out.txt",
                "missing.md",
                "references/guide.md/",
                "empty",
                "",
            }
        )
        {
            var result = await host.Ctl(
                owner,
                "skill load demo @path",
                new JsonObject { ["path"] = path }
            );
            Assert.Equal($"`{path}` is not a resource of skill `demo`.", Error(result));
        }
        // A nested skill's files are resources of the parent, and the listing cap limits only the listing.
        Assert.Contains("nested notes", Output(await host.Ctl(owner, "skill load demo nested/notes.md")));
        Assert.Contains("file 204", Output(await host.Ctl(owner, "skill load demo many/204.txt")));
        var guide = Output(await host.Ctl(owner, "skill load demo references/guide.md"));
        Assert.StartsWith("FILE: demo/references/guide.md\nguide\n", guide);
        Assert.DoesNotContain(demo, guide);
    }

    [Fact]
    public async Task Resource_reads_match_read_for_ranges_large_files_images_and_directories()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        var lines = string.Concat(Enumerable.Range(1, 9).Select(n => $"line {n}\n"));
        var text = Put(demo, "references/lines.txt", lines);
        var large = Put(demo, "data/large.txt", new string('a', 600_000) + "\n" + new string('b', 600_000) + "\n");
        Directory.CreateDirectory(Path.Combine(demo, "images"));
        File.WriteAllBytes(Path.Combine(demo, "images", "dot.png"), Convert.FromBase64String(Png1x1));
        var owner = await host.Agent("reader", null);
        var workspace = new WorkspaceTools(host.F.Work);

        async Task<string> Read(string path, JsonObject? range = null)
        {
            var args = new JsonObject { ["filePath"] = path };
            foreach (var (key, value) in range ?? new JsonObject())
                args[key] = value?.DeepClone();
            var call = new JsonObject { ["name"] = "read", ["args"] = args };
            return SessionWait.Text((await workspace.ExecuteAsync(call, default))["output"])!;
        }

        var ranged = Output(await host.Ctl(owner, "skill load demo references/lines.txt --start-line 3 --end-line 4"));
        Assert.Equal(
            "FILE: demo/references/lines.txt\n"
                + (await Read(text, new JsonObject { ["startLine"] = 3, ["endLine"] = 4 })).Replace(text, "demo/references/lines.txt"),
            ranged
        );
        var excerpt = Output(await host.Ctl(owner, "skill load demo data/large.txt"));
        Assert.Equal("FILE: demo/data/large.txt\n" + (await Read(large)).Replace(large, "demo/data/large.txt"), excerpt);
        Assert.Contains(new FileInfo(large).Length.ToString(), excerpt);
        var image = await host.Ctl(owner, "skill load demo images/dot.png");
        Assert.Equal("image/png", SessionWait.Text(image["inlineData"]!["mimeType"]));
        Assert.Equal(Png1x1, SessionWait.Text(image["inlineData"]!["data"]));
        // Directories list their resources as paths relative to the skill, with or without a slash.
        var listing = Output(await host.Ctl(owner, "skill load demo references"));
        Assert.Equal("DIRECTORY: demo/references/\n- references/lines.txt\n", listing);
        Assert.Equal(listing, Output(await host.Ctl(owner, "skill load demo references/")));
        // A line range applies only to a resource.
        Assert.NotNull((await host.Ctl(owner, "skill load demo --start-line 2"))["error"]);
    }

    [Fact]
    public async Task Resources_resolve_like_load_with_shadowing_and_agentName()
    {
        await using var host = await Host.Create();
        Put(host.Write("demo"), "references/global.md", "global copy\n");
        var owner = await host.Agent("reader", null);
        var local = RunnableSkillTests.WriteSkill(
            Path.Combine(host.F.Manager.AgentDirectory("reader"), "skills"),
            "demo",
            "",
            entry: null
        );
        Put(local, "references/local.md", "local copy\n");
        Assert.Contains("local copy", Output(await host.Ctl(owner, "skill load demo references/local.md")));
        // The shadowed global skill's files are not reached through the local one.
        Assert.Equal(
            "`references/global.md` is not a resource of skill `demo`.",
            Error(await host.Ctl(owner, "skill load demo references/global.md"))
        );
        // Another Agent's chain resolves to the global skill.
        Assert.Contains(
            "global copy",
            Output(await host.Ctl(owner, "skill load demo references/global.md --agent-name main"))
        );
        Assert.Contains("not found", Error(await host.Ctl(owner, "skill load absent references/x.md")));
    }

    [Fact]
    public async Task A_template_restricted_worker_reads_global_resources_without_a_master_read()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/guide.md", "guide body\n");
        var worker = await host.Agent("worker", RestrictedWorkerRules());
        Assert.Contains(
            "guide body",
            Output(await host.Ctl(worker, "skill load demo references/guide.md"))
        );
        Assert.Contains("- references/guide.md", Output(await host.Ctl(worker, "skill load demo references")));
        // The same file is out of reach of `read` on master.
        Assert.Equal("master", host.F.Manager.CurrentNode(worker));
        var read = (
            await host.Tools(worker)
                .ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "read",
                        ["name"] = "read",
                        ["args"] = new JsonObject { ["filePath"] = Path.Combine(demo, "references", "guide.md") },
                    },
                    default
                )
        )!.AsObject();
        Assert.Equal("tool_authorization_denied", read.FailureCode());
        Assert.Contains("no-master", read.ToJsonString());
        // A path rule on the skill tool can withhold resources while keeping SKILL.md.
        var textOnly = RestrictedWorkerRules();
        textOnly.Insert(
            0,
            JsonNode.Parse(
                """{"id":"text-only","tool":{"source":"builtin","name":"skill"},"args":{"path":{"exists":true}},"action":"deny"}"""
            )
        );
        await host.F.Manager.SetAgentRulesAsync("worker", textOnly);
        Assert.Equal("tool_authorization_denied", (await host.Ctl(worker, "skill load demo references/guide.md")).FailureCode());
        Assert.Contains("Skill: demo", Output(await host.Ctl(worker, "skill load demo")));
    }

    [Fact]
    public async Task The_load_header_names_paths_relative_to_the_skill_and_the_master_path_only_on_master()
    {
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/guide.md");
        var onMaster = await host.Agent("reader", null);
        var remote = await host.F.Manager.CreateNamedAsync("reader", "remote", null, null, initialNode: "sandbox-x");
        Assert.Equal("sandbox-x", host.F.Manager.CurrentNode(remote));
        var master = Output(await host.Ctl(onMaster, "skill load demo"));
        var elsewhere = Output(await host.Ctl(remote, "skill load demo"));
        Assert.Contains("\nOn master, the skill directory is " + demo + ".\n", master);
        Assert.DoesNotContain(demo, elsewhere);
        Assert.Equal(master.Replace("\nOn master, the skill directory is " + demo + ".", ""), elsewhere);
        Assert.Contains("\nFILE: demo/SKILL.md\n", elsewhere);
        Assert.Contains("ctl skill load demo <path>", elsewhere);
        Assert.Contains("ctl skill load demo --agent-name main <path>", Output(await host.Ctl(remote, "skill load demo --agent-name main")));
        Assert.Contains("\n- references/guide.md\n", elsewhere);
    }

    [Fact]
    public async Task Scripts_get_structured_read_fields_without_the_Main_server_path()
    {
        if (!(OperatingSystem.IsLinux() && MontyWorker.IsSupported))
            return;
        await using var host = await Host.Create();
        var demo = host.Write("demo");
        Put(demo, "references/lines.txt", "one\ntwo\nthree\n");
        var owner = await host.Agent("reader", null);
        var result = (
            await host.Tools(owner)
                .ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "script",
                        ["name"] = "run_script",
                        ["args"] = new JsonObject
                        {
                            ["code"] = "r = call_tool('skill', {'action': 'load', 'skillName': 'demo', 'path': 'references/lines.txt', 'startLine': 2, 'endLine': 2})\nreturn {k: r.get(k) for k in ['content', 'sizeBytes', 'startLine', 'endLine', 'path', 'filePath']}\n",
                        },
                    },
                    default
                )
        )!.AsObject();
        Assert.True(SessionWait.Text(result["status"]) == "completed", result.ToJsonString());
        var fields = result["result"]!.AsObject();
        Assert.Equal("two\n", SessionWait.Text(fields["content"]));
        Assert.Equal(14, fields["sizeBytes"]!.GetValue<long>());
        Assert.Equal(2, fields["startLine"]!.GetValue<long>());
        Assert.Equal("references/lines.txt", SessionWait.Text(fields["path"]));
        Assert.Null(fields["filePath"]);
    }
}
