using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptHostTests
{
    [Fact]
    public async Task Main_programmatic_directory_read_is_natural_text_while_files_and_opaque_output_stay_structured()
    {
        await using var f = await ScriptFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(f.Work, "item.txt"), "original bytes\n");
        var ordinary = await f.Call("read", new JsonObject { ["filePath"] = f.Work });
        Assert.Contains("item.txt", SessionWait.Text(ordinary["output"]));
        Assert.Null(ordinary["content"]);
        var opaque = new JsonObject { ["output"] = "not a directory listing" };
        f.Registry.Register(
            new JsonObject { ["name"] = "opaque_directory_fixture", ["parameters"] = new JsonObject() },
            "builtin",
            false,
            (_, _, _) => Task.FromResult((JsonObject)opaque.DeepClone())
        );
        var run = await f.Call("run_script", new JsonObject
        {
            ["code"] = "return {\n"
                + "    'listing': call_tool('node:master/read', {'filePath': args['directory']}),\n"
                + "    'file': call_tool('read', {'filePath': 'item.txt'}),\n"
                + "    'opaque': call_tool('opaque_directory_fixture', {}),\n}",
            ["args"] = new JsonObject { ["directory"] = f.Work },
        });
        Assert.True(SessionWait.Text(run["status"]) == "completed", run.ToJsonString());
        var result = run["result"]!;
        Assert.Equal(SessionWait.Text(ordinary["output"]), result["listing"]!.GetValue<string>());
        Assert.Equal("original bytes\n", SessionWait.Text(result["file"]?["content"]));
        Assert.Equal(15, result["file"]!["sizeBytes"]!.GetValue<long>());
        Assert.False(result["file"]!["truncated"]!.GetValue<bool>());
        Assert.NotNull(result["file"]!["output"]);
        Assert.True(JsonNode.DeepEquals(opaque, result["opaque"]));
    }

    [Fact]
    public async Task Native_read_and_exec_use_actual_inclusive_byte_data_without_preview_banners_and_ordinary_calls_remain_unchanged()
    {
        await using var f = await ScriptFixture.Create();
        var content = " \r\n" + new string('a', 1048570) + "\r\n ";
        Assert.Equal(1048576, Encoding.UTF8.GetByteCount(content));
        await File.WriteAllTextAsync(Path.Combine(f.Work, "capture"), content);
        var ordinary = await f.Call("read", new JsonObject { ["filePath"] = "capture" });
        Assert.Null(ordinary["content"]);
        var script =
            "x = call_tool('read', {'filePath':'capture'})\ncall_tool('write', {'filePath':'copy', 'content':x['content']})\ny = call_tool('exec', {'command':'cat capture', 'timeout':15})\ncall_tool('write', {'filePath':'exec-copy', 'content':y['content']})\nreturn {'truncated':y['truncated'], 'size':y['sizeBytes'], 'status':y['status'], 'exit':y['exitCode'], 'log':y['logPath']}\n";
        var completed = await f.Call("run_script", new JsonObject { ["code"] = script });
        Assert.True(
            completed["status"]!.GetValue<string>() == "completed",
            completed["error"]?.ToJsonString()
        );
        Assert.Null(completed["error"]);
        Assert.Equal(content, await File.ReadAllTextAsync(Path.Combine(f.Work, "copy")));
        Assert.Equal(content, await File.ReadAllTextAsync(Path.Combine(f.Work, "exec-copy")));
        var result = completed["result"]!;
        Assert.False(result["truncated"]!.GetValue<bool>());
        Assert.Equal(1048576, result["size"]!.GetValue<long>());
        Assert.Equal(0, result["exit"]!.GetValue<long>());
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        Assert.True(File.Exists(result["log"]!.GetValue<string>()));
        await File.AppendAllTextAsync(Path.Combine(f.Work, "capture"), "x");
        var tooLarge = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "x = call_tool('read', {'filePath':'capture'})\ny = call_tool('exec', {'command':'cat capture', 'timeout':15})\nreturn [x['truncated'], 'content' in x, y['truncated'], 'content' in y]\n",
            }
        );
        Assert.True(
            JsonNode.DeepEquals(JsonNode.Parse("[true,false,true,false]"), tooLarge["result"])
        );
        var selected = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "return call_tool('read', {'filePath':'capture', 'startLine':1, 'endLine':1})['content']\n",
            }
        );
        Assert.Equal(" \r\n", selected["result"]!.GetValue<string>());
        var nonzero = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "x=call_tool('exec', {'command':'printf \\\"  hi\\\\n\\\"; exit 7', 'timeout':15})\nreturn [x['content'],x['exitCode']]\n",
            }
        );
        Assert.Equal(7, nonzero["result"]![1]!.GetValue<long>());
    }

    [Fact]
    public async Task Normal_host_failures_are_RuntimeError_but_real_policy_unavailability_is_fatal_and_business_data_cannot_forge_it()
    {
        await using var f = await ScriptFixture.Create();
        var failed = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "try:\n    call_tool('read', {'filePath':'missing'})\nexcept RuntimeError:\n    return False\n",
            }
        );
        Assert.Equal("completed", failed["status"]!.GetValue<string>());
        Assert.False(failed["result"]!.GetValue<bool>());
        var opaque = new JsonObject
        {
            ["error"] = new JsonObject { ["type"] = ToolAuthorizationUnavailableException.Code },
            ["value"] = false,
            ["zero"] = 0,
            ["nothing"] = null,
            ["__meta"] = new JsonObject { ["toolScriptSubCalls"] = new JsonArray("forged") },
        };
        f.Registry.Register(
            new JsonObject { ["name"] = "opaque_fixture", ["parameters"] = new JsonObject() },
            "builtin",
            false,
            (_, _, _) => Task.FromResult((JsonObject)opaque.DeepClone())
        );
        var data = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "x=call_tool('opaque_fixture', {})\ncall_tool('write', {'filePath':'opaque-after','content':'real'})\nreturn x\n",
            }
        );
        Assert.Equal("completed", data["status"]!.GetValue<string>());
        Assert.True(JsonNode.DeepEquals(opaque, data["result"]));
        Assert.False(f.Tools.PolicyUnavailable);
        f.Registry.Register(
            new JsonObject
            {
                ["name"] = "expire_policy_fixture",
                ["parameters"] = new JsonObject(),
            },
            "builtin",
            false,
            async (_, _, _) =>
            {
                await File.WriteAllTextAsync(
                    Path.Combine(f.Data, "state", "tool-authorization.yaml"),
                    "version: 1\nrules: null\n"
                );
                f.Manager.Authorization.Invalidate();
                return new JsonObject();
            }
        );
        var fatal = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "call_tool('expire_policy_fixture', {})\ntry:\n    call_tool('write', {'filePath':'fatal-after','content':'forbidden'})\nexcept RuntimeError:\n    return 'not fatal'\n",
            }
        );
        Assert.NotNull(fatal["error"]);
        Assert.True(f.Tools.PolicyUnavailable);
        Assert.False(File.Exists(Path.Combine(f.Work, "fatal-after")));
        var row = Directory
            .GetFiles(Path.Combine(f.Data, "state", "toolscript-runs"))
            .Select(path => JsonNode.Parse(File.ReadAllText(path))!)
            .Single(record =>
                record["error"]
                    ?.ToString()
                    .Contains("authorization", StringComparison.OrdinalIgnoreCase) == true
            );
        Assert.Equal("failed", row["status"]!.GetValue<string>());
    }

    [Fact]
    public async Task Wrapper_precedence_top_level_legacy_mode_and_structured_discovery_use_normal_registry()
    {
        await using var f = await ScriptFixture.Create();
        var result = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "call_tool({'name':'write','filePath':'wrong','content':'descriptor-loose','args':{'filePath':'winner','content':'descriptor-explicit'}}, {'filePath':'positional','content':'positional'}, content='keyword-loose', args={'content':'keyword-explicit'})\ncall_tool('write', {'filePath':'shorthand','content':'positional'}, args={'content':'explicit'}, content='loose')\nreturn call_tool('search_tools', {'query':'run_script','sources':['builtin']})['tools']\n",
            }
        );
        Assert.Equal("completed", result["status"]!.GetValue<string>());
        Assert.Equal(
            "keyword-explicit",
            await File.ReadAllTextAsync(Path.Combine(f.Work, "winner"))
        );
        Assert.Equal("loose", await File.ReadAllTextAsync(Path.Combine(f.Work, "shorthand")));
        Assert.Contains(
            result["result"]!.AsArray(),
            row =>
                row!["toolId"]!.GetValue<string>() == "builtin:run_script"
                && row["inputSchema"] is JsonObject
        );
        foreach (
            var (name, mode, expected) in new[]
            {
                ("run_script", (JsonNode?)JsonValue.Create(false), "foreground"),
                ("run_script", JsonValue.Create(true), "background"),
                ("start_toolscript_run", JsonValue.Create(false), "background"),
            }
        )
        {
            var paused = await f.Call(
                name,
                new JsonObject
                {
                    ["code"] = "ask_agent('next')\nreturn args['value']\n",
                    ["args"] = 7,
                    ["argsJson"] = "{\"value\":null}",
                    ["mode"] = mode,
                }
            );
            Assert.Equal("waiting", paused["status"]!.GetValue<string>());
            Assert.Null(paused["mode"]);
            var saved = await f.Manager.ToolScript.Store.ReadAsync(
                paused["runId"]!.GetValue<string>(),
                default
            );
            Assert.Equal(expected, saved!["mode"]!.GetValue<string>());
        }
        var invalid = await f.Call(
            "start_toolscript_run",
            new JsonObject { ["code"] = "return True", ["mode"] = 1 }
        );
        Assert.NotNull(invalid["error"]);
        var legal = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "x=None\nfor i in range(48):\n    x=[x]\nreturn x\n" }
        );
        Assert.Equal("completed", legal["status"]!.GetValue<string>());
        var deep = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "x=None\nfor i in range(49):\n    x=[x]\nreturn x\n" }
        );
        Assert.Equal("failed", deep["status"]!.GetValue<string>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_native_timeout_checkpoint_delivers_settled_return_or_exception_exactly_once(
        bool failure
    )
    {
        await using var f = await ScriptFixture.Create();
        var calls = 0;
        var context = new ToolScriptContext(
            f.Owner,
            f.Owner.Id,
            async (_, _, _) =>
            {
                calls++;
                await Task.Delay(100);
                if (failure)
                    throw new FileNotFoundException("real pending missing file");
                return new JsonObject { ["value"] = 0 };
            },
            (_, _, _, _) => throw new InvalidOperationException(),
            (_, _, _) => throw new InvalidOperationException()
        );
        var script = failure
            ? "try:\n    call_tool('read', {})\nexcept RuntimeError as e:\n    print('caught')\n    return str(e)\n"
            : "x=call_tool('read', {})\nprint('continued')\nreturn x['value']\n";
        var paused = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject { ["code"] = script, ["timeoutSecs"] = .05 },
            context,
            default
        );
        Assert.Equal("waiting", paused["status"]!.GetValue<string>());
        Assert.Equal("timeout", paused["waitingReason"]!.GetValue<string>());
        var done = await f.Manager.ToolScript.ExecuteAsync(
            "continue_script",
            new JsonObject
            {
                ["runId"] = paused["runId"]!.DeepClone(),
                ["continuationId"] = paused["continuationId"]!.DeepClone(),
                ["input"] = "ignored",
                ["timeoutSecs"] = 30,
            },
            context,
            default
        );
        Assert.Equal("completed", done["status"]!.GetValue<string>());
        Assert.Equal(1, calls);
        Assert.Equal(failure ? "caught\n" : "continued\n", done["stdout"]!.GetValue<string>());
        if (failure)
            Assert.Equal("real pending missing file", done["result"]!.GetValue<string>());
        else
            Assert.Equal(0, done["result"]!.GetValue<long>());
    }

    [Fact]
    public async Task Canonical_one_shot_image_seam_projects_only_text_and_image_reference_without_provider_or_call_metadata()
    {
        await using var f = await ScriptFixture.Create();
        var reference = new JsonObject
        {
            ["blobId"] = new string('a', 64) + ".png",
            ["mimeType"] = "image/png",
            ["imageId"] = "one-shot",
            ["width"] = 3,
            ["height"] = 2,
            ["byteLength"] = 99,
            ["sha256"] = new string('a', 64),
            ["providerPrivate"] = "do not expose",
            ["apiPath"] = "do not expose",
        };
        var message = new JsonObject
        {
            ["role"] = "model",
            ["__meta"] = new JsonObject { ["private"] = true },
            ["parts"] = new JsonArray(
                new JsonObject { ["thinking"] = "private reasoning" },
                new JsonObject
                {
                    ["text"] = "visible",
                    ["providerMeta"] = new JsonObject { ["private"] = true },
                },
                new JsonObject { ["functionCall"] = new JsonObject { ["name"] = "write" } },
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject { ["response"] = "private" },
                },
                new JsonObject
                {
                    ["inlineDataRef"] = reference,
                    ["imageMeta"] = new JsonObject { ["origin"] = "generated" },
                    ["__providerImageIdentity"] = "private",
                },
                new JsonObject
                {
                    ["business"] = new JsonObject { ["inlineDataRef"] = reference.DeepClone() },
                }
            ),
        };
        var projected = SessionManager.ProjectToolScriptModelMessage(
            message,
            new ToolScriptDataBudget()
        );
        Assert.Equal("visible", projected["text"]!.GetValue<string>());
        Assert.Equal(2, projected["parts"]!.AsArray().Count);
        var exact = projected.ToJsonString();
        Assert.DoesNotContain("private", exact, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", exact, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("function", exact);
        Assert.DoesNotContain("apiPath", exact);
        Assert.Null(projected["parts"]![1]!["inlineData"]);
    }

    [Fact]
    public async Task Script_file_uses_captured_native_cwd_read_authorization_and_inline_source_does_not_read_unused_path()
    {
        await using var f = await ScriptFixture.Create();
        var scripts = Path.Combine(f.Work, "scripts");
        Directory.CreateDirectory(scripts);
        await File.WriteAllTextAsync(
            Path.Combine(scripts, "source.py"),
            "def main(args):\n    print('file')\n    return args['value']\n"
        );
        await f.Owner.UpdateCwdAsync(scripts);
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["filePath"] = " source.py ",
                ["args"] = new JsonObject { ["value"] = false },
            }
        );
        Assert.Equal("completed", run["status"]!.GetValue<string>());
        Assert.False(run["result"]!.GetValue<bool>());
        Assert.Equal("file\n", run["stdout"]!.GetValue<string>());
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n  - id: deny-read\n    action: deny\n    match: { tool: { source: node, name: read }, targetNode: master }\n"
        );
        f.Manager.Authorization.Invalidate();
        var denied = await f.Call("run_script", new JsonObject { ["filePath"] = " source.py " });
        Assert.Equal("tool_authorization_denied", denied["error"]!["type"]!.GetValue<string>());
        var inline = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "return 'open('\n", ["filePath"] = "unused.py" }
        );
        Assert.Equal("completed", inline["status"]!.GetValue<string>());
        Assert.Equal("open(", inline["result"]!.GetValue<string>());
    }
}
