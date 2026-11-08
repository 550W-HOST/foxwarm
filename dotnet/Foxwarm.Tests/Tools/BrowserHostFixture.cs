using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Foxwarm.Tests;

// Test-owned environment for the real browser host: the installed Chromium, a loopback site, and
// (only when this environment cannot give Chromium its own sandbox) a launcher wrapper selected
// through the standard executable variable. Foxwarm itself never disables the sandbox.
internal static class BrowserHostFixture
{
    private static readonly Lazy<string?> chromium = new(PrepareChromium);

    internal static string? Chromium => chromium.Value;

    internal static string? BundlePath
    {
        get
        {
            var path = BrowserHost.DefaultBundlePath();
            return File.Exists(path) ? path : null;
        }
    }

    internal static bool CanRunBrowser =>
        !OperatingSystem.IsWindows()
        && BundlePath is not null
        && BrowserHost.FindNode() is not null
        && Chromium is not null;

    private static string? PrepareChromium()
    {
        var found = new[]
        {
            Environment.GetEnvironmentVariable("FOXWARM_CHROMIUM"),
            Environment.GetEnvironmentVariable("PUPPETEER_EXECUTABLE_PATH"),
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
        }.FirstOrDefault(path => !string.IsNullOrEmpty(path) && File.Exists(path));
        if (found is null || OperatingSystem.IsWindows())
            return null;
        var selected = found;
        if (!StartsWithOwnSandbox(found))
        {
            var directory = Path.Combine(Path.GetTempPath(), "fw-test-chromium-" + Guid.NewGuid());
            Directory.CreateDirectory(directory);
            selected = Path.Combine(directory, "chromium-wrapper.sh");
            File.WriteAllText(selected, $"#!/bin/sh\nexec \"{found}\" --no-sandbox \"$@\"\n");
            File.SetUnixFileMode(selected, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        Environment.SetEnvironmentVariable("PUPPETEER_EXECUTABLE_PATH", selected);
        return selected;
    }

    private static bool StartsWithOwnSandbox(string executable)
    {
        var info = new ProcessStartInfo(executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in new[] { "--headless=new", "--disable-gpu", "--dump-dom", "about:blank" })
            info.ArgumentList.Add(argument);
        try
        {
            using var process = Process.Start(info)!;
            process.StandardOutput.ReadToEndAsync();
            process.StandardError.ReadToEndAsync();
            if (process.WaitForExit(20000))
                return process.ExitCode == 0;
            process.Kill(entireProcessTree: true);
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    // A loopback HTTP site. Routes: "/stall" never answers; anything else serves `pages`.
    internal sealed class Site : IAsyncDisposable
    {
        private readonly HttpListener listener = new();
        private readonly CancellationTokenSource stop = new();
        private readonly Task loop;

        internal Site(Dictionary<string, string> pages)
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Origin = "http://127.0.0.1:" + port;
            listener.Prefixes.Add(Origin + "/");
            listener.Start();
            loop = Task.Run(async () =>
            {
                while (!stop.IsCancellationRequested)
                {
                    HttpListenerContext context;
                    try
                    {
                        context = await listener.GetContextAsync();
                    }
                    catch (Exception error)
                        when (error is HttpListenerException or ObjectDisposedException)
                    {
                        return;
                    }
                    var path = context.Request.Url!.AbsolutePath;
                    if (path == "/stall")
                        continue;
                    if (pages.TryGetValue(path, out var html))
                    {
                        var bytes = Encoding.UTF8.GetBytes(html);
                        context.Response.ContentType = "text/html; charset=utf-8";
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    else
                        context.Response.StatusCode = 404;
                    context.Response.Close();
                }
            });
        }

        internal string Origin { get; }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Abort();
            await loop;
        }
    }
}
