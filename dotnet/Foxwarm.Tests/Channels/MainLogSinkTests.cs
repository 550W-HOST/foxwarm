using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests.Channels;

// Tests that replace the process console run alone.
[CollectionDefinition("Process console", DisableParallelization = true)]
public sealed class ProcessConsoleCollection;

// Several Main logs in one process share one Console capture; each line goes to one sink.
[Collection("Process console")]
public sealed class MainLogSinkTests
{
    [Fact]
    public void LogsShareOneCaptureAndALineGoesToTheSinkOfItsFlow()
    {
        using var temp = new TempDirectory();
        var originalOut = Console.Out;
        var originalError = Console.Error;
        using var output = new StringWriter();
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        var first = Path.Combine(temp.Path, "first", "state", "logs", "foxwarm.log");
        var second = Path.Combine(temp.Path, "second", "state", "logs", "foxwarm.log");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", null);
            Console.SetOut(output);
            var before = Console.Out;
            var alpha = new MainLog(first, null, jsonStdout: true, tenant: "alpha");
            var captured = Console.Out;
            var beta = new MainLog(second, null, jsonStdout: true, tenant: "beta");
            // The second log joins the capture instead of wrapping it.
            Assert.Same(captured, Console.Out);

            Task.Run(() =>
                {
                    beta.UseFor();
                    Console.WriteLine("from beta");
                })
                .Wait();
            Task.Run(() =>
                {
                    alpha.UseFor();
                    Console.WriteLine("from alpha {\"quoted\": 1}");
                })
                .Wait();
            // A line of no known flow goes only to the process.
            Task.Run(() => Console.WriteLine("unscoped")).Wait();

            beta.Dispose();
            // The capture stays while a log is open; a closed sink no longer receives records.
            Assert.Same(captured, Console.Out);
            Task.Run(() =>
                {
                    beta.UseFor();
                    Console.WriteLine("after beta closed");
                })
                .Wait();
            alpha.Dispose();
            Assert.Same(before, Console.Out);
            Assert.Same(originalError, Console.Error);

            var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .ToArray();
            Assert.Equal(
                [
                    ("beta", "from beta"),
                    ("alpha", "from alpha {\"quoted\": 1}"),
                    ((string?)null, "unscoped"),
                    (null, "after beta closed"),
                ],
                lines.Select(line => (line["tenant"]?.ToString(), line["msg"]!.ToString()))
            );
            Assert.Equal(
                ["level", "time", "pid", "hostname", "tenant", "msg"],
                lines[0].Select(property => property.Key)
            );
            Assert.Equal(
                ["from alpha {\"quoted\": 1}"],
                File.ReadLines(first).Select(line => line[(line.IndexOf("INFO: ", StringComparison.Ordinal) + 6)..])
            );
            Assert.Equal(
                ["from beta"],
                File.ReadLines(second).Select(line => line[(line.IndexOf("INFO: ", StringComparison.Ordinal) + 6)..])
            );
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    [Fact]
    public void ALineOfNoKnownFlowIsMaskedWithTheSecretsOfEveryOpenLog()
    {
        const string alphaValue = "synthetic-alpha-secret-0001";
        const string betaValue = "synthetic-beta-secret-0002";
        using var temp = new TempDirectory();
        var alphaConfiguration = Configuration(Path.Combine(temp.Path, "alpha"), "alpha-key", alphaValue);
        var betaConfiguration = Configuration(Path.Combine(temp.Path, "beta"), "beta-key", betaValue);
        var originalOut = Console.Out;
        var originalError = Console.Error;
        using var output = new StringWriter();
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", null);
            Console.SetOut(output);
            using (var alpha = new MainLog(alphaConfiguration, tenant: "alpha"))
            using (var beta = new MainLog(betaConfiguration, tenant: "beta"))
            {
                Task.Run(() => Console.WriteLine("both " + alphaValue + " " + betaValue)).Wait();
                Task.Run(() =>
                    {
                        beta.UseFor();
                        Console.WriteLine("beta's own " + betaValue);
                    })
                    .Wait();
            }
            var console = output.ToString();
            Assert.Contains("both [[FW_SECRET:alpha-key]] [[FW_SECRET:beta-key]]\n", console);
            Assert.Contains("beta's own [[FW_SECRET:beta-key]]\n", console);
            Assert.DoesNotContain(alphaValue, console);
            Assert.DoesNotContain(betaValue, console);
            Assert.DoesNotContain(betaValue, File.ReadAllText(MainLog.Destination(betaConfiguration)));
            Assert.DoesNotContain(alphaValue, File.ReadAllText(MainLog.Destination(alphaConfiguration)));
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    [Fact]
    public async Task PartialLinesAreAssembledAndMaskedPerSink()
    {
        const string alphaValue = "synthetic-alpha-secret-0003";
        const string betaValue = "synthetic-beta-secret-0004";
        using var temp = new TempDirectory();
        var alphaConfiguration = Configuration(Path.Combine(temp.Path, "alpha"), "alpha-key", alphaValue);
        var betaConfiguration = Configuration(Path.Combine(temp.Path, "beta"), "beta-key", betaValue);
        var originalOut = Console.Out;
        var originalError = Console.Error;
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", null);
            Console.SetOut(new StringWriter());
            var alpha = new MainLog(alphaConfiguration, tenant: "alpha");
            var beta = new MainLog(betaConfiguration, tenant: "beta");
            var alphaTurn = new SemaphoreSlim(0);
            var betaTurn = new SemaphoreSlim(0);
            // Each value is split across writes, and the two flows' writes interleave.
            var first = Task.Run(async () =>
            {
                alpha.UseFor();
                Console.Write("alpha holds " + alphaValue[..9]);
                betaTurn.Release();
                await alphaTurn.WaitAsync();
                Console.Write(alphaValue[9..] + " done\n");
                betaTurn.Release();
            });
            var second = Task.Run(async () =>
            {
                beta.UseFor();
                await betaTurn.WaitAsync();
                Console.Write("beta holds " + betaValue[..11]);
                alphaTurn.Release();
                await betaTurn.WaitAsync();
                Console.Write(betaValue[11..] + " done\n");
            });
            await Task.WhenAll(first, second);
            // A sink that closes records its own partial line and leaves the other's pending.
            Task.Run(() =>
                {
                    beta.UseFor();
                    Console.Write("beta partial");
                })
                .Wait();
            Task.Run(() =>
                {
                    alpha.UseFor();
                    Console.Write("alpha partial");
                })
                .Wait();
            beta.Dispose();
            Task.Run(() =>
                {
                    alpha.UseFor();
                    Console.Write(" continues\n");
                })
                .Wait();
            alpha.Dispose();
            Assert.Equal(
                ["alpha holds [[FW_SECRET:alpha-key]] done", "alpha partial continues"],
                Messages(MainLog.Destination(alphaConfiguration))
            );
            Assert.Equal(
                ["beta holds [[FW_SECRET:beta-key]] done", "beta partial"],
                Messages(MainLog.Destination(betaConfiguration))
            );
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    private static readonly AsyncLocal<string?> CallerScope = new();

    [Fact]
    public void DetachedWorkLogsToTheCallersSinkWithoutTheCallersOtherScopes()
    {
        using var temp = new TempDirectory();
        var originalOut = Console.Out;
        var originalError = Console.Error;
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", null);
            Console.SetOut(new StringWriter());
            var process = new MainLog(Path.Combine(temp.Path, "process.log"), null);
            var tenant = new MainLog(Path.Combine(temp.Path, "tenant.log"), null, tenant: "alpha");
            string? seen = "unset";
            Task.Run(() =>
                {
                    tenant.UseFor();
                    CallerScope.Value = "caller";
                    Task? work = null;
                    MainLog.Detached(() =>
                        work = Task.Run(async () =>
                        {
                            await Task.Yield();
                            seen = CallerScope.Value;
                            Console.WriteLine("detached work");
                        })
                    );
                    work!.Wait();
                    // Lines of the process's own flow go to its sink.
                    MainLog.UseProcess();
                    Console.WriteLine("cluster line");
                })
                .Wait();
            tenant.Dispose();
            process.Dispose();
            Assert.Null(seen);
            Assert.Equal(["detached work"], Messages(Path.Combine(temp.Path, "tenant.log")));
            Assert.Equal(["cluster line"], Messages(Path.Combine(temp.Path, "process.log")));
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    private static string[] Messages(string path) =>
        File.ReadLines(path)
            .Select(line => line[(line.IndexOf(": ", line.IndexOf(']'), StringComparison.Ordinal) + 2)..])
            .ToArray();

    [Fact]
    public void ALogWithAnotherConsoleFormatCannotJoinTheCapture()
    {
        using var temp = new TempDirectory();
        var originalOut = Console.Out;
        var originalError = Console.Error;
        try
        {
            using var output = new StringWriter();
            Console.SetOut(output);
            using var hosted = new MainLog(Path.Combine(temp.Path, "a.log"), null, jsonStdout: true);
            Assert.Throws<InvalidOperationException>(() => new MainLog(Path.Combine(temp.Path, "b.log"), null));
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
        }
    }

    private static ModelConfiguration Configuration(string root, string name, string value)
    {
        Directory.CreateDirectory(Path.Combine(root, "state"));
        File.WriteAllText(Path.Combine(root, "state", "config.yaml"), "vector: false\n");
        var configuration = new ModelConfiguration(root);
        configuration.Secrets.Open();
        configuration.Secrets.Store.Set(name, value);
        _ = configuration.Secrets.Redactor;
        return configuration;
    }
}
