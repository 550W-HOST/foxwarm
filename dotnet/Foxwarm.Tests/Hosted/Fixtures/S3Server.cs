using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// One disposable S3-compatible server per test process. FOXWARM_TEST_VERSITYGW names a
/// VersityGW executable, which the fixture runs with its POSIX backend under a short /tmp path,
/// random root credentials and an ephemeral loopback port; FOXWARM_TEST_S3_URL instead names an
/// existing endpoint whose credentials come from FOXWARM_TEST_S3_ACCESS_KEY and
/// FOXWARM_TEST_S3_SECRET_KEY. These variables are read only here, in the test assembly. Tests
/// take a bucket name of their own from <see cref="NewBucketName"/>.
/// </summary>
internal sealed class S3Server
{
    internal const string ExecutableVariable = "FOXWARM_TEST_VERSITYGW";
    internal const string UrlVariable = "FOXWARM_TEST_S3_URL";
    internal const string Region = "us-east-1";

    private static readonly Lazy<Task<S3Server>> shared = new(() => StartAsync(false));
    private static readonly Lazy<Task<S3Server>> versioned = new(() => StartAsync(true));
    private static int bucketCounter;

    private S3Server(Uri endpoint, string accessKey, string secretKey)
    {
        Endpoint = endpoint;
        AccessKey = accessKey;
        SecretKey = secretKey;
    }

    internal static bool Configured =>
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(ExecutableVariable))
        || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable(UrlVariable));

    internal Uri Endpoint { get; }

    internal string AccessKey { get; }

    internal string SecretKey { get; }

    internal static Task<S3Server> SharedAsync(bool enableVersioning = false) =>
        Configured
            ? (enableVersioning ? versioned : shared).Value
            : throw new InvalidOperationException(
                $"Hosted blob tests need an S3 server: set {ExecutableVariable} to a VersityGW executable or {UrlVariable} to an endpoint."
            );

    /// <summary>A bucket name no other test of any process uses.</summary>
    internal static string NewBucketName() =>
        $"fw-test-{Environment.ProcessId}-{Interlocked.Increment(ref bucketCounter)}-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(3))}";

    private static async Task<S3Server> StartAsync(bool enableVersioning)
    {
        var url = Environment.GetEnvironmentVariable(UrlVariable);
        if (!string.IsNullOrEmpty(url))
            return new S3Server(
                new Uri(url),
                Environment.GetEnvironmentVariable("FOXWARM_TEST_S3_ACCESS_KEY") ?? "",
                Environment.GetEnvironmentVariable("FOXWARM_TEST_S3_SECRET_KEY") ?? ""
            );
        var executable = Environment.GetEnvironmentVariable(ExecutableVariable)!;
        if (!File.Exists(executable))
            throw new InvalidOperationException($"{ExecutableVariable} doesn't name a file: {executable}");
        var root = Path.Combine("/tmp", "fws3-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6)));
        var data = Path.Combine(root, "data");
        Directory.CreateDirectory(data, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var accessKey = "fw" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var secretKey = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(20));
        for (int attempt = 1; ; attempt++)
        {
            var port = ChildListenerPorts.Sample();
            try { return await StartGatewayAsync(executable, root, data, accessKey, secretKey, enableVersioning, port); }
            catch (IOException error) when (attempt < ChildListenerPorts.MaxAttempts && ChildListenerPorts.IsCollision(error.Message)) { }
        }
    }

    private static async Task<S3Server> StartGatewayAsync(string executable,string root,string data,string accessKey,string secretKey,bool enableVersioning,int port)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[] { "--port", $"127.0.0.1:{port}", "--region", Region, "posix" })
            start.ArgumentList.Add(argument);
        if (enableVersioning)
        {
            var versions = Path.Combine(root, "versions");
            Directory.CreateDirectory(versions);
            start.ArgumentList.Add("--versioning-dir");
            start.ArgumentList.Add(versions);
        }
        start.ArgumentList.Add(data);
        // Credentials through the environment keep them out of the process list.
        start.Environment["ROOT_ACCESS_KEY_ID"] = accessKey;
        start.Environment["ROOT_SECRET_ACCESS_KEY"] = secretKey;
        var process = Process.Start(start)!;
        var errors = new System.Collections.Generic.Queue<string>();
        process.OutputDataReceived += (_,_) => { };
        process.ErrorDataReceived += (_,line) =>
        {
            if (line.Data is null) return;
            lock (errors)
            {
                if (errors.Count >= 16) errors.Dequeue();
                errors.Enqueue(line.Data);
            }
        };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        var endpoint = new Uri($"http://127.0.0.1:{port}");
        try { await WaitUntilServingAsync(endpoint, process, errors); }
        catch
        {
            if (!process.HasExited) process.Kill();
            process.Dispose();
            throw;
        }
        // Removes the server and its data when this process ends, also when it is killed.
        var watcher = new ProcessStartInfo("setsid") { UseShellExecute = false, RedirectStandardInput = true };
        foreach (var argument in new[] { "sh", "-c", $"exec </dev/null >/dev/null 2>&1; while kill -0 {Environment.ProcessId} 2>/dev/null; do sleep 2; done; kill {process.Id}; sleep 1; rm -rf '{root}'" })
            watcher.ArgumentList.Add(argument);
        Process.Start(watcher)!.Dispose();
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try
            {
                process.Kill();
                process.WaitForExit(5_000);
                Directory.Delete(root, true);
            }
            catch { }
        };
        return new S3Server(endpoint, accessKey, secretKey);
    }

    // The gateway answers HTTP once it serves.
    private static async Task WaitUntilServingAsync(Uri endpoint, Process process, Queue<string> errors)
    {
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromSeconds(30))
        {
            if (process.HasExited)
            {
                process.WaitForExit(); // Drain redirected stderr before classifying the exit.
                lock (errors) throw new IOException($"VersityGW exited with code {process.ExitCode} at startup: {string.Join("\n",errors)}");
            }
            try
            {
                using var response = await http.GetAsync(endpoint);
                // The unsigned bucket listing is refused with an S3 request ID. An unrelated
                // HTTP service on the candidate port is not this fixture becoming ready.
                if (response.Headers.Contains("x-amz-request-id")) return;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            await Task.Delay(100);
        }
        throw new TimeoutException("VersityGW didn't start serving within 30 s.");
    }
}
