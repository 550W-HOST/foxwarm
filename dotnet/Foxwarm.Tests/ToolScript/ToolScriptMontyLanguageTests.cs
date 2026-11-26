using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

/// <summary>The pinned Monty release's language support and sandbox policy, through the real worker.</summary>
[Trait("Backend", "neutral")]
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
    [InlineData("import os\nos.getenv('HOME')", "RuntimeError: 'os.getenv'")]
    [InlineData("import os\nos.environ['HOME']", "RuntimeError: 'os.environ'")]
    [InlineData("import os\nos.urandom(4)", "RuntimeError: 'os.urandom'")]
    [InlineData("from pathlib import Path\nPath('/etc/hostname').read_text()", "PermissionError")]
    [InlineData("import helpers", "ModuleNotFoundError")]
    public async Task Environment_files_and_local_imports_stay_rejected_as_host_requests(
        string code,
        string error
    )
    {
        await using var f = await ScriptFixture.Create();
        var failed = await f.Call("run_script", new JsonObject { ["code"] = code });
        Assert.Equal("failed", SessionWait.Text(failed["status"]));
        Assert.Contains(error, SessionWait.Text(failed["error"]));
    }

    [Fact]
    public async Task Clock_and_unseeded_random_read_the_worker_clock_and_entropy()
    {
        await using var f = await ScriptFixture.Create();
        const string code =
            "import datetime, time, random\n"
            + "return [time.time(), datetime.datetime.now().isoformat(), str(datetime.date.today()),"
            + " str(datetime.datetime.now().tzinfo), random.random(), random.Random().random()]\n";
        var before = DateTimeOffset.UtcNow;
        var first = await f.Call("run_script", new JsonObject { ["code"] = code });
        var second = await f.Call("run_script", new JsonObject { ["code"] = code });
        var after = DateTimeOffset.UtcNow;
        Assert.Equal("completed", SessionWait.Text(first["status"]));
        Assert.Equal("completed", SessionWait.Text(second["status"]));
        var a = first["result"]!.AsArray();
        var b = second["result"]!.AsArray();
        var now = DateTimeOffset.FromUnixTimeMilliseconds((long)(a[0]!.GetValue<double>() * 1000));
        Assert.InRange(now, before.AddSeconds(-1), after.AddSeconds(1));
        // Naive datetime.now() and date.today() read in UTC.
        var naive = DateTime.Parse(a[1]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
        Assert.InRange(naive, before.UtcDateTime.AddSeconds(-1), after.UtcDateTime.AddSeconds(1));
        Assert.Equal(naive.ToString("yyyy-MM-dd"), a[2]!.GetValue<string>());
        Assert.Equal("None", a[3]!.GetValue<string>());
        // Unseeded generators start from fresh entropy in every run.
        Assert.NotEqual(a[4]!.GetValue<double>(), b[4]!.GetValue<double>());
        Assert.NotEqual(a[5]!.GetValue<double>(), b[5]!.GetValue<double>());
    }

    [Fact]
    public async Task Sleep_waits_within_the_time_limit_and_returns_none()
    {
        await using var f = await ScriptFixture.Create();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var run = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] =
                    "import time, asyncio\n"
                    + "a = time.monotonic()\n"
                    + "r = time.sleep(0.3)\n"
                    + "async def nap():\n    await asyncio.sleep(0.2)\n    return 'woke'\n"
                    + "return [r, asyncio.run(nap()), time.monotonic() - a]\n",
                ["timeoutSecs"] = 5,
            }
        );
        Assert.Equal("completed", SessionWait.Text(run["status"]));
        var values = run["result"]!.AsArray();
        Assert.Null(values[0]);
        Assert.Equal("woke", values[1]!.GetValue<string>());
        Assert.True(values[2]!.GetValue<double>() >= 0.5, values.ToJsonString());
        Assert.True(watch.Elapsed >= TimeSpan.FromSeconds(0.5));
    }

    [Fact]
    public async Task A_sleep_past_the_time_limit_pauses_there_and_continues_until_its_end_instant()
    {
        await using var f = await ScriptFixture.Create();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var paused = await f.Call(
            "run_script",
            new JsonObject
            {
                ["code"] = "import time\nprint('before')\ntime.sleep(2)\nreturn 'slept'\n",
                ["timeoutSecs"] = .4,
            }
        );
        var first = watch.Elapsed;
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        Assert.Equal("timeout", SessionWait.Text(paused["waitingReason"]));
        // The slice ends at its limit, not at the end of the sleep.
        Assert.InRange(first, TimeSpan.FromSeconds(.35), TimeSpan.FromSeconds(1.5));
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            SessionWait.Text(paused["runId"])!,
            default
        );
        Assert.Equal(
            "time.sleep",
            SessionWait.Text(record!["waiting"]!["timeout"]!["pausedAtFunctionName"])
        );
        Assert.Equal(
            "sleep",
            SessionWait.Text(record["waiting"]!["timeout"]!["pendingResume"]!["mode"])
        );
        // A continuation with a short limit sleeps on and pauses again.
        var again = await f.Call("continue_script", Resume(paused, null, .4));
        Assert.Equal("waiting", SessionWait.Text(again["status"]));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(1.9));
        // A continuation with room waits only for the rest of the sleep.
        var done = await f.Call("continue_script", Resume(again, null, 10));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.Equal("slept", done["result"]!.GetValue<string>());
        Assert.InRange(watch.Elapsed, TimeSpan.FromSeconds(1.95), TimeSpan.FromSeconds(4));
        Assert.Equal("before\n", SessionWait.Text(done["stdout"]) ?? "before\n");
    }

    [Fact]
    public async Task A_sleep_whose_end_passed_while_paused_resumes_at_once()
    {
        await using var f = await ScriptFixture.Create();
        var paused = await f.Call(
            "run_script",
            new JsonObject { ["code"] = "import time\ntime.sleep(0.6)\nreturn 1\n", ["timeoutSecs"] = .2 }
        );
        Assert.Equal("waiting", SessionWait.Text(paused["status"]));
        await Task.Delay(700);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var done = await f.Call("continue_script", Resume(paused, null, 10));
        Assert.Equal("completed", SessionWait.Text(done["status"]));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(.5), watch.Elapsed.ToString());
    }

    [Fact]
    public async Task Stop_interrupts_a_sleeping_script_promptly_with_an_exception_at_the_sleep()
    {
        await using var f = await ScriptFixture.Create();
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(400));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var result = (
            await f.Tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = "sleeping-script",
                    ["name"] = "run_script",
                    ["args"] = new JsonObject
                    {
                        ["code"] =
                            "import time\ntry:\n    time.sleep(60)\nexcept RuntimeError as e:\n    print('caught', e)\n"
                            + "time.sleep(60)\nreturn 'not reached'\n",
                        ["timeoutSecs"] = 120,
                    },
                },
                stop.Token
            )
        )!.AsObject();
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), watch.Elapsed.ToString());
        var record = await f.Manager.ToolScript.Store.ReadAsync(
            SessionWait.Text(result["runId"])!,
            default
        );
        Assert.Equal("failed", SessionWait.Text(record!["status"]));
        // The first sleep is interrupted; the second is refused at once.
        Assert.Contains("caught Sleep was interrupted", SessionWait.Text(record["stdout"]));
        Assert.Contains("Sleep was interrupted", SessionWait.Text(record["error"]));
    }

    [Fact]
    public async Task Cancellation_ends_a_sleeping_foreground_run_promptly()
    {
        await using var f = await ScriptFixture.Create();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var running = f.Call(
            "run_script",
            new JsonObject { ["code"] = "import time\ntime.sleep(60)\n", ["timeoutSecs"] = 120 }
        );
        string? runId = null;
        while (runId is null && watch.Elapsed < TimeSpan.FromSeconds(10))
        {
            await Task.Delay(50);
            var rows = await f.Manager.ToolScript.Store.ListAsync(f.Owner.Id, 10, "running", default);
            runId = rows.Count > 0 ? SessionWait.Text(rows[0]["runId"]) : null;
        }
        Assert.NotNull(runId);
        await Task.Delay(300);
        var cancelled = await f.Call("cancel_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.True(cancelled["cancellationRequested"]!.GetValue<bool>());
        var result = await running.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("cancelled", SessionWait.Text(result["status"]));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10));
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
