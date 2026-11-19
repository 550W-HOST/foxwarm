using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

/// <summary>The pinned Monty release's language support and sandbox policy, through the real worker.</summary>
public sealed class ToolScriptMontyLanguageTests
{
    private static JsonObject Resume(JsonObject paused, JsonNode? input = null, double? timeout = null)
    {
        var args = new JsonObject
        {
            ["runId"] = paused["runId"]!.DeepClone(),
            ["continuationId"] = paused["continuationId"]!.DeepClone(),
        };
        if (input is not null)
            args["input"] = input;
        if (timeout is double seconds)
            args["timeoutSecs"] = seconds;
        return args;
    }

    [Fact]
    public async Task Printf_style_and_format_forms_run_in_the_pinned_worker()
    {
        await using var f = await ScriptFixture.Create();
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "n = 5\n"
                    + "return {\n"
                    + "    'tuple': 'x%d' % (n,),\n"
                    + "    'single': 'v=%s|%r|%5.2f|%x|%%' % ('a', 'b', 2.5, 255),\n"
                    + "    'mapping': '%(a)s-%(b)03d' % {'a': 'q', 'b': 7},\n"
                    + "    'format': format(3.14159, '.2f') + '|' + format(255, 'x') + '|' + format(1234567, ','),\n"
                    + "    'method': '{}-{:>5}-{:.2f}-{!r}'.format('a', 'b', 2.0, 'z'),\n"
                    + "    'fstring': f'{n:04d}|{n!r}',\n"
                    + "}\n",
            }
        );
        Assert.Equal("completed", SessionWait.Text(run["status"]));
        var result = run["result"]!;
        Assert.Equal("x5", result["tuple"]!.GetValue<string>());
        Assert.Equal("v=a|'b'| 2.50|ff|%", result["single"]!.GetValue<string>());
        Assert.Equal("q-007", result["mapping"]!.GetValue<string>());
        Assert.Equal("3.14|ff|1,234,567", result["format"]!.GetValue<string>());
        Assert.Equal("a-    b-2.00-'z'", result["method"]!.GetValue<string>());
        Assert.Equal("0005|5", result["fstring"]!.GetValue<string>());
    }

    [Fact]
    public async Task Agent_pause_continues_in_a_fresh_worker_and_formats_with_the_answer()
    {
        await using var f = await ScriptFixture.Create();
        var paused = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "print('before %d' % (1,))\nanswer = ask_agent('which?')\nprint('after %s' % (answer,))\nreturn 'got %s' % (answer,)\n",
            }
        );
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        Assert.Equal("agent", SessionWait.Text(paused["waitingReason"]));
        Assert.Equal("before 1\n", SessionWait.Text(paused["stdout"]));
        var done = await f.Call("continue_script", Resume(paused, "blue"));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.Equal("after blue\n", SessionWait.Text(done["stdout"]));
        Assert.Equal("got blue", SessionWait.Text(done["result"]));
    }

    [Fact]
    public async Task Execution_time_limit_belongs_to_the_run_and_survives_a_timeout_continuation()
    {
        await using var f = await ScriptFixture.Create();
        var context = new ToolScriptContext(
            f.Owner,
            f.Owner.Id,
            async (_, _, _) =>
            {
                // Longer than the slice budget, so the run pauses at the checkpoint.
                await Task.Delay(500);
                return new JsonObject();
            },
            (_, _, _, _) => throw new InvalidOperationException(),
            (_, _, _) => throw new InvalidOperationException()
        );
        var paused = await f.Manager.ToolScript.ExecuteAsync(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "for i in range(100000):\n    pass\ncall_tool('read', {})\nfor i in range(2000000000):\n    pass\nreturn 'unbounded'\n",
                ["timeoutSecs"] = .3,
            },
            context,
            default
        );
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        Assert.Equal("timeout", SessionWait.Text(paused["waitingReason"]));
        // The continuation asks for 30 seconds, but the snapshot keeps the run's own limit.
        var failed = await f.Manager.ToolScript.ExecuteAsync(
            "continue_script",
            Resume(paused, "ignored", 30),
            context,
            default
        );
        Assert.Equal("failed", SessionWait.Text(failed["status"]));
        Assert.Contains("TimeoutError", SessionWait.Text(failed["error"]));
    }

    [Theory]
    [InlineData("import datetime\ndatetime.datetime.now()", "datetime.now")]
    [InlineData("import datetime\ndatetime.date.today()", "date.today")]
    [InlineData("import time\ntime.time()", "time.time")]
    [InlineData("import time\ntime.sleep(0.01)", "time.sleep")]
    [InlineData("import random\nrandom.random()", "os.urandom")]
    [InlineData("import os\nos.getenv('HOME')", "os.getenv")]
    public async Task Clock_sleep_entropy_and_environment_stay_rejected_as_host_requests(
        string code,
        string name
    )
    {
        await using var f = await ScriptFixture.Create();
        var failed = await f.Call("run_script", new JsonObject { ["code"] = code });
        Assert.Equal("failed", SessionWait.Text(failed["status"]));
        Assert.Contains("RuntimeError", SessionWait.Text(failed["error"]));
        Assert.Contains(name, SessionWait.Text(failed["error"]));
    }

    [Fact]
    public async Task Seeded_random_and_other_new_pure_modules_work()
    {
        await using var f = await ScriptFixture.Create();
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "import random, itertools, functools, hashlib, base64, copy\n"
                    + "random.seed(3)\n"
                    + "return [random.random(), list(itertools.chain([1], [2])), functools.reduce(lambda a, b: a + b, [1, 2, 3]),"
                    + " hashlib.sha256(b'a').hexdigest()[:8], copy.deepcopy([1, [2]])]\n",
            }
        );
        Assert.Equal("completed", SessionWait.Text(run["status"]));
        var values = run["result"]!.AsArray();
        Assert.Equal(0.23796462709189137, values[0]!.GetValue<double>());
        Assert.Equal(6, values[2]!.GetValue<long>());
        Assert.Equal("ca978112", values[3]!.GetValue<string>());
    }

    [Fact]
    public async Task Sandbox_classes_return_their_repr_and_class_instances_ask_for_a_projection()
    {
        await using var f = await ScriptFixture.Create();
        var type = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "class Q:\n    pass\nreturn [Q, ValueError, len]\n" }
        );
        Assert.Equal("completed", SessionWait.Text(type["status"]));
        var values = type["result"]!.AsArray();
        Assert.Equal("<class 'Q'>", values[0]!.GetValue<string>());
        Assert.Equal("Type", values[1]!["__monty_type__"]!.GetValue<string>());
        Assert.Equal("BuiltinFunction", values[2]!["__monty_type__"]!.GetValue<string>());
        var instance = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "class Q:\n    pass\nreturn Q()\n" }
        );
        Assert.Equal("failed", SessionWait.Text(instance["status"]));
        Assert.Contains("JSON-compatible projection", SessionWait.Text(instance["error"]));
    }

    [Fact]
    public async Task Stderr_prints_join_the_captured_stdout_in_order()
    {
        await using var f = await ScriptFixture.Create();
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "import sys\nprint('out')\nprint('err', file=sys.stderr)\nprint('out2')\nreturn 1\n",
            }
        );
        Assert.Equal("completed", SessionWait.Text(run["status"]));
        Assert.Equal("out\nerr\nout2\n", SessionWait.Text(run["stdout"]));
    }
}
