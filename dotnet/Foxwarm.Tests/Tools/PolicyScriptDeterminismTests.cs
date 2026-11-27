using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

[CollectionDefinition("PolicyScriptStaticHooks", DisableParallelization = true)]
public sealed class PolicyScriptStaticHooksCollection;

/// <summary>
/// Empirical verification of Monty 1.6.0 determinism, refused OS/host calls, resource bounds, and
/// strict JSON output enforcement against the real packaged worker.
/// </summary>
[Collection("PolicyScriptStaticHooks")]
public sealed class PolicyScriptDeterminismTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Cross_process_determinism_for_set_frozenset_hash_id_repr_and_sys()
    {
        const string probe = """
            class Box:
                pass
            def fn(x):
                return x
            s1 = {"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"}
            s2 = {str(i) for i in range(40)}
            fs = frozenset(["alpha", "beta", "gamma", "delta", "epsilon"])
            b = Box()
            return {
                "set_str": list(s1),
                "set_num": list(s2),
                "frozenset": list(fs),
                "hashes": [hash("alpha"), hash("beta"), hash("gamma"), hash((1, "a")), hash(fs)],
                "ids": [id([]), id({}), id(b), id("hello")],
                "reprs": [repr(Box), repr(b), repr(fn), repr(lambda y: y)],
                "dict_keys": list({"z": 1, "a": 2, "m": 3}.keys()),
            }
            """;

        var runs = new List<string>();
        for (var i = 0; i < 8; i++)
        {
            var result = await PolicyScriptRunner.EvaluateRawAsync(probe, null, $"probe-{i}");
            var json = result!.ToJsonString();
            runs.Add(json);
            if (i == 0)
                output.WriteLine("Run 0: " + json);
        }

        Assert.All(runs, r => Assert.Equal(runs[0], r));
    }

    [Fact]
    public async Task Process_time_and_sys_constants_are_deterministic_and_zeroed()
    {
        const string probe = """
            import time, sys
            acc = 0
            for i in range(10000):
                acc += i
            return {
                "process_time": time.process_time(),
                "thread_time": time.thread_time(),
                "platform": sys.platform,
                "acc": acc,
            }
            """;
        var a = (await PolicyScriptRunner.EvaluateRawAsync(probe, null, "p1"))!.AsObject();
        var b = (await PolicyScriptRunner.EvaluateRawAsync(probe, null, "p2"))!.AsObject();
        Assert.Equal(0d, a["process_time"]!.GetValue<double>());
        Assert.Equal(0d, a["thread_time"]!.GetValue<double>());
        Assert.Equal(a.ToJsonString(), b.ToJsonString());
    }

    [Theory]
    [InlineData("import time\nreturn time.time()", "clock")]
    [InlineData("import time\nreturn time.time_ns()", "clock")]
    [InlineData("import time\nreturn time.monotonic()", "clock")]
    [InlineData("import time\nreturn time.monotonic_ns()", "clock")]
    [InlineData("import time\nreturn time.perf_counter()", "clock")]
    [InlineData("import time\nreturn time.perf_counter_ns()", "clock")]
    [InlineData("import time\nreturn time.localtime()", "clock")]
    [InlineData("import time\nreturn time.gmtime()", "clock")]
    [InlineData("import time\nreturn time.ctime()", "clock")]
    [InlineData("import time\nreturn time.strftime('%Y')", "clock")]
    [InlineData("import datetime\nreturn str(datetime.datetime.now())", "clock")]
    [InlineData("import datetime\nreturn str(datetime.datetime.now(datetime.timezone.utc))", "clock")]
    [InlineData("import datetime\nreturn str(datetime.date.today())", "clock")]
    [InlineData("import time\ntime.sleep(0)\nreturn []", "sleep")]
    [InlineData("import time\ntime.sleep(0.01)\nreturn []", "sleep")]
    [InlineData("import asyncio\nasyncio.run(asyncio.sleep(0))\nreturn []", "sleep")]
    [InlineData("import random\nreturn random.random()", "random")]
    [InlineData("import random\nreturn random.randint(1, 10)", "random")]
    [InlineData("import random\nreturn random.Random().random()", "random")]
    [InlineData("import random\nrandom.seed()\nreturn random.random()", "random")]
    [InlineData("import os\nreturn os.urandom(4)", "random")]
    [InlineData("import os\nreturn os.getenv('PATH')", "environment")]
    [InlineData("import os\nreturn dict(os.environ)", "environment")]
    [InlineData("from pathlib import Path\nreturn Path('/etc/hostname').read_text()", "OS / filesystem")]
    [InlineData("return open('/etc/hostname').read()", "OS / filesystem")]
    [InlineData("import helpers\nreturn []", "module import")]
    [InlineData("import socket\nreturn []", "module import")]
    [InlineData("import subprocess\nreturn []", "module import")]
    [InlineData("import uuid\nreturn []", "module import")]
    [InlineData("import secrets\nreturn []", "module import")]
    [InlineData("call_tool('read', {})\nreturn []", "host function `call_tool`")]
    [InlineData("ask_agent('hi')\nreturn []", "host function `ask_agent`")]
    [InlineData("request_model_without_context('hi')\nreturn []", "host function `request_model_without_context`")]
    [InlineData("return unknown_var", "undefined name `unknown_var`")]
    public async Task Refused_nondeterministic_and_io_calls_are_rejected(string code, string expected)
    {
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRawAsync(code, null, "refuse-test")
        );
        Assert.Contains(expected, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Try_except_cannot_swallow_refused_os_or_host_calls()
    {
        const string code = """
            import time
            try:
                time.time()
            except Exception:
                pass
            return []
            """;
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRawAsync(code, null, "no-swallow")
        );
        Assert.Contains("line 3", error.Message);
    }

    [Fact]
    public async Task Resource_limits_enforce_cpu_memory_recursion_and_size_bounds()
    {
        var cpu = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync("while True:\n    pass\nreturn []", null, "cpu")
        );
        Assert.Contains("time limit", cpu.Message, StringComparison.OrdinalIgnoreCase);

        var mem = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(
                "x = [0] * 10000000\nreturn []",
                null,
                "mem"
            )
        );
        Assert.Contains("Memory", mem.Message, StringComparison.OrdinalIgnoreCase);

        var rec = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(
                "def f(n):\n    return f(n + 1)\nreturn f(0)",
                null,
                "rec"
            )
        );
        Assert.Contains("RecursionError", rec.Message);

        var hugeScript = new string(' ', PolicyScriptRunner.MaxScriptBytes + 1) + "return []";
        var scriptSize = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(hugeScript, null, "huge")
        );
        Assert.Contains("limit", scriptSize.Message, StringComparison.OrdinalIgnoreCase);

        var tooMany = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(
                "return [{'id': f'r-{i}', 'action': 'allow'} for i in range(257)]",
                null,
                "many"
            )
        );
        Assert.Contains("256-rule", tooMany.Message);

        var tooLarge = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(
                "return [{'id': f'r-{i}', 'action': 'deny', 'reason': 'x' * 1200} for i in range(230)]",
                null,
                "large"
            )
        );
        Assert.Contains("limit", tooLarge.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("return {'action': 'allow'}", "list of rule objects")]
    [InlineData("return None", "list of rule objects")]
    [InlineData("return {1, 2}", "unsupported value type")]
    [InlineData("return [b'abc']", "unsupported value type")]
    [InlineData("import datetime\nreturn [datetime.date(2026, 1, 1)]", "unsupported value type")]
    [InlineData("return [float('nan')]", "non-finite float")]
    [InlineData("return [float('inf')]", "non-finite float")]
    [InlineData("return [{1: 'a'}]", "dict keys must be strings")]
    public async Task Non_list_and_non_json_return_values_are_rejected(string code, string expected)
    {
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            PolicyScriptRunner.EvaluateRulesAsync(code, null, "strict-json")
        );
        Assert.Contains(expected, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Missing_worker_refuses_scripted_policies_while_plain_policies_still_parse()
    {
        var previous = PolicyScriptRunner.BinaryOverride;
        PolicyScriptRunner.BinaryOverride = () => "/nonexistent/monty-missing";
        try
        {
            var scripted = System.Text.Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: deny\nscript: |\n  return []\n"
            );
            var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
                ToolAuthorizationYaml.ParseAsync(scripted)
            );
            Assert.Contains("Monty worker", error.Message);

            var plain = System.Text.Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: deny\nrules:\n  - id: r1\n    action: allow\n"
            );
            var parsed = await ToolAuthorizationYaml.ParseAsync(plain);
            Assert.Single(parsed.Value["rules"]!.AsArray());
        }
        finally
        {
            PolicyScriptRunner.BinaryOverride = previous;
        }
    }

    [Fact]
    public async Task Concurrent_policy_compilations_are_bounded_to_two()
    {
        var active = 0;
        var maxObserved = 0;
        var previous = PolicyScriptRunner.OnBeforeSpawn;
        PolicyScriptRunner.OnBeforeSpawn = () =>
        {
            var current = Interlocked.Increment(ref active);
            int prior;
            do
            {
                prior = Volatile.Read(ref maxObserved);
            } while (
                current > prior
                && Interlocked.CompareExchange(ref maxObserved, current, prior) != prior
            );
            Thread.Sleep(30);
            Interlocked.Decrement(ref active);
        };
        try
        {
            var tasks = Enumerable
                .Range(0, 6)
                .Select(i =>
                    PolicyScriptRunner.EvaluateRulesAsync(
                        $"return [{{'id': 'r-{i}', 'action': 'allow'}}]",
                        null,
                        $"conc-{i}"
                    )
                )
                .ToArray();
            var results = await Task.WhenAll(tasks);
            Assert.Equal(6, results.Length);
            Assert.InRange(maxObserved, 1, 2);
        }
        finally
        {
            PolicyScriptRunner.OnBeforeSpawn = previous;
        }
    }

    [Fact]
    public async Task Startup_delay_does_not_consume_execution_wall_clock_and_timeouts_report_phase()
    {
        var prevSpawn = PolicyScriptRunner.OnBeforeSpawn;
        var prevStartup = PolicyScriptRunner.StartupWallClockOverride;
        var prevExec = PolicyScriptRunner.ExecutionWallClockOverride;
        try
        {
            // Startup takes longer than the execution wall-clock limit (250ms > 120ms),
            // yet the script succeeds because execution wall clock starts only after Configure.
            PolicyScriptRunner.StartupWallClockOverride = TimeSpan.FromSeconds(5);
            PolicyScriptRunner.ExecutionWallClockOverride = TimeSpan.FromMilliseconds(150);
            PolicyScriptRunner.OnBeforeSpawn = () => Thread.Sleep(250);
            var ok = await PolicyScriptRunner.EvaluateRulesAsync(
                "return [{'id': 'after-slow-start', 'action': 'allow'}]",
                null,
                "slow-start"
            );
            Assert.Single(ok);

            // Startup timeout reports startup phase clearly and is marked transient.
            PolicyScriptRunner.StartupWallClockOverride = TimeSpan.FromMilliseconds(40);
            PolicyScriptRunner.ExecutionWallClockOverride = TimeSpan.FromSeconds(2);
            PolicyScriptRunner.OnBeforeSpawn = () => Thread.Sleep(120);
            var startupErr = await Assert.ThrowsAsync<InvalidDataException>(() =>
                PolicyScriptRunner.EvaluateRulesAsync("return []", null, "startup-timeout")
            );
            Assert.True(PolicyScriptRunner.IsTransient(startupErr));
            Assert.Contains("startup timed out", startupErr.Message, StringComparison.OrdinalIgnoreCase);

            // Execution wall-clock timeout reports execution phase clearly and is marked transient.
            PolicyScriptRunner.OnBeforeSpawn = null;
            PolicyScriptRunner.StartupWallClockOverride = TimeSpan.FromSeconds(5);
            PolicyScriptRunner.ExecutionWallClockOverride = TimeSpan.FromMilliseconds(30);
            var execErr = await Assert.ThrowsAsync<InvalidDataException>(() =>
                PolicyScriptRunner.EvaluateRulesAsync(
                    "while True:\n    pass\nreturn []",
                    null,
                    "exec-timeout"
                )
            );
            Assert.True(PolicyScriptRunner.IsTransient(execErr));
            Assert.Contains("execution wall-clock", execErr.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            PolicyScriptRunner.OnBeforeSpawn = prevSpawn;
            PolicyScriptRunner.StartupWallClockOverride = prevStartup;
            PolicyScriptRunner.ExecutionWallClockOverride = prevExec;
        }
    }
}
