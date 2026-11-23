using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Stopping native background commands on request, and the wrapper's signal handling.
public sealed class ExecStopTests
{
    private sealed class Harness : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal readonly List<(string Session, string Id, string Message)> Completions = [];
        internal LocalExecManager Manager { get; }

        internal Harness()
        {
            Manager = new LocalExecManager(
                Temp.Path,
                _ => Temp.Path,
                (session, id, message) =>
                {
                    lock (Completions)
                        Completions.Add((session, id, message));
                    return Task.CompletedTask;
                }
            );
        }

        internal async Task<JsonObject> Background(string command, string session = "owner")
        {
            var result = await Manager.ExecuteAsync(
                session,
                new JsonObject { ["command"] = command, ["timeout"] = 1 },
                default
            );
            Assert.True(result["output"] is not null, result.ToJsonString());
            ExecReceipt.Header(result["output"]!.GetValue<string>());
            return Assert.Single(Manager.Tracked, entry =>
                entry["id"]!.GetValue<string>() == ExecReceipt.Id(result["output"]!.GetValue<string>())
            );
        }

        internal async Task<string> Completion(string id)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            while (true)
            {
                await Manager.ReconcileNowAsync();
                lock (Completions)
                    if (Completions.Any(item => item.Id == id))
                        return Assert.Single(Completions, item => item.Id == id).Message;
                await Task.Delay(50, deadline.Token);
            }
        }

        internal string FilePath(string name) => Path.Combine(Temp.Path, name);

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    private static bool Posix => OperatingSystem.IsLinux() || OperatingSystem.IsMacOS();

    private static bool Alive(int pid) => ExecStop.Running(pid, null);

    private static async Task Until(Func<bool> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
            await Task.Delay(25, deadline.Token);
    }

    [Fact]
    public async Task Stop_terminates_the_process_group_and_completion_arrives_once_marked_stopped()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var child = h.FilePath("child.pid");
        var entry = await h.Background($"sleep 30 & echo $! > '{child}'; wait");
        var id = entry["id"]!.GetValue<string>();
        await Until(() => File.Exists(child) && File.ReadAllText(child).Trim().Length > 0);
        var childPid = int.Parse(File.ReadAllText(child).Trim());
        var listed = Assert.Single(h.Manager.Running("owner"));
        Assert.Equal(id, listed.Id);
        Assert.False(listed.StopRequested);

        var (outcome, _) = await h.Manager.StopAsync("owner", id, default);
        Assert.Equal(LocalExecManager.StopOutcome.Stopped, outcome);
        Assert.False(Alive(childPid));

        var message = await h.Completion(id);
        var header = ExecReceipt.Header(message);
        Assert.Equal(id, ExecReceipt.Id(message));
        Assert.Contains("143", header);
        Assert.Empty(h.Manager.Running("owner"));
        // Neither a repeated stop nor a later reconciliation repeats the completion.
        Assert.Equal(
            LocalExecManager.StopOutcome.NotOwned,
            (await h.Manager.StopAsync("owner", id, default)).Outcome
        );
        await h.Manager.ReconcileNowAsync();
        Assert.Single(h.Completions);
    }

    [Fact]
    public async Task A_second_stop_while_the_first_is_pending_is_reported_and_not_repeated()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        // Ignores TERM, so the first stop waits for its grace period.
        var entry = await h.Background("trap '' TERM; sleep 30");
        var id = entry["id"]!.GetValue<string>();
        var first = h.Manager.StopAsync("owner", id, default);
        await Until(() => h.Manager.Running("owner").Single().StopRequested);
        Assert.Equal(
            LocalExecManager.StopOutcome.AlreadyRequested,
            (await h.Manager.StopAsync("owner", id, default)).Outcome
        );
        Assert.Equal(LocalExecManager.StopOutcome.Killed, (await first).Outcome);
        var header = ExecReceipt.Header(await h.Completion(id));
        Assert.Contains("unknown", header);
        Assert.Single(h.Completions);
    }

    [Fact]
    public async Task Stopping_a_command_that_already_finished_reports_it_and_delivers_an_ordinary_completion()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var entry = await h.Background("sleep 1.8; exit 3");
        var id = entry["id"]!.GetValue<string>();
        await Until(() => File.Exists(entry["statusPath"]!.GetValue<string>()));
        Assert.Equal(
            LocalExecManager.StopOutcome.Finished,
            (await h.Manager.StopAsync("owner", id, default)).Outcome
        );
        var stopped = ExecReceipt.Header(await h.Completion(id));

        var other = await h.Background("sleep 1.8; exit 3");
        var normal = ExecReceipt.Header(await h.Completion(other["id"]!.GetValue<string>()));
        Assert.Equal(
            normal.Replace(other["id"]!.GetValue<string>(), "id"),
            stopped.Replace(id, "id")
        );
    }

    [Fact]
    public async Task Another_Session_cannot_list_or_stop_the_command()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var entry = await h.Background("sleep 30");
        var id = entry["id"]!.GetValue<string>();
        Assert.Empty(h.Manager.Running("intruder"));
        Assert.Equal(
            LocalExecManager.StopOutcome.NotOwned,
            (await h.Manager.StopAsync("intruder", id, default)).Outcome
        );
        Assert.Equal(
            LocalExecManager.StopOutcome.NotOwned,
            (await h.Manager.StopAsync("owner", "no-such", default)).Outcome
        );
        Assert.True(Alive(checked((int)entry["pid"]!.GetValue<long>())));
        Assert.Equal(
            LocalExecManager.StopOutcome.Stopped,
            (await h.Manager.StopAsync("owner", id, default)).Outcome
        );
    }

    [Fact]
    public async Task A_command_TERM_trap_still_runs_and_sets_its_own_exit_status()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var entry = await h.Background(
            "trap 'echo cleanup ran; exit 7' TERM; sleep 30 & wait"
        );
        var id = entry["id"]!.GetValue<string>();
        Assert.Equal(
            LocalExecManager.StopOutcome.Stopped,
            (await h.Manager.StopAsync("owner", id, default)).Outcome
        );
        var message = await h.Completion(id);
        Assert.Contains("7", ExecReceipt.Header(message));
        Assert.Contains("\ncleanup ran\n", message);
    }

    [Theory]
    [InlineData("exit 0", 0)]
    [InlineData("exit 5", 5)]
    [InlineData("false", 1)]
    [InlineData("(exit 9)", 9)]
    public async Task Without_a_signal_the_wrapper_records_the_real_exit_code(
        string command,
        int expected
    )
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var result = await h.Manager.ExecuteAsync(
            "owner",
            new JsonObject { ["command"] = command },
            default
        );
        Assert.Contains(
            $"Exit code: {expected}\n",
            result["output"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Signalling_only_the_wrapper_records_termination_instead_of_success()
    {
        if (!Posix)
            return;
        await using var h = new Harness();
        var entry = await h.Background("sleep 2.5");
        var id = entry["id"]!.GetValue<string>();
        // Only the wrapper shell, not its process group: it finishes the running child first.
        using (
            var kill = global::System.Diagnostics.Process.Start(
                "kill",
                ["-TERM", entry["pid"]!.GetValue<long>().ToString()]
            )!
        )
            await kill.WaitForExitAsync();
        var header = ExecReceipt.Header(await h.Completion(id));
        Assert.Contains("143", header);
    }
}
