using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class BrowserHostTests
{
    private const string Page = """
        <!doctype html><title>Fixture</title>
        <input id="entry" aria-label="Entry"><p id="mirror"></p>
        <button id="go" onclick="document.getElementById('mirror').textContent='clicked'">Go</button>
        <script>
        const input = document.getElementById('entry');
        const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        let seen = '';
        Object.defineProperty(input, 'value', { configurable: true,
          get() { return native.get.call(this); }, set(v) { seen = String(v); native.set.call(this, v); } });
        input.addEventListener('input', () => {
          const now = native.get.call(input);
          if (now !== seen) { seen = now; document.getElementById('mirror').textContent = 'mirror:' + now; }
        });
        </script>
        """;

    private static JsonObject Args(string json) => JsonNode.Parse(json)!.AsObject();

    private static string DescribeScript(string directory, string json)
    {
        var path = Path.Combine(directory, "fake-node.sh");
        File.WriteAllText(path, "#!/bin/sh\ncat <<'EOF'\n" + json + "\nEOF\n");
        File.SetUnixFileMode(
            path,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        );
        return path;
    }

    [Fact]
    public void Executable_lookup_falls_back_to_conventional_directories_after_PATH()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var tool = Path.Combine(temp.Path, "fw-fake-tool");
        File.WriteAllText(tool, "#!/bin/sh\n");
        File.SetUnixFileMode(
            tool,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        );
        Assert.Null(BrowserHost.FindExecutable("fw-fake-tool"));
        Assert.Equal(tool, BrowserHost.FindExecutable("fw-fake-tool", [temp.Path]));
        File.SetUnixFileMode(tool, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Assert.Null(BrowserHost.FindExecutable("fw-fake-tool", [temp.Path]));
    }

    [Fact]
    public void Missing_node_or_bundle_makes_the_host_unavailable_without_tools()
    {
        using var temp = new TempDirectory();
        var bundle = Path.Combine(temp.Path, "bundle.cjs");
        File.WriteAllText(bundle, "");
        var noNode = new BrowserHost(bundle, Path.Combine(temp.Path, "no-such-node")).Describe();
        Assert.False(noNode.Available);
        Assert.Empty(noNode.Tools);
        var noBundle = new BrowserHost(
            Path.Combine(temp.Path, "absent.cjs"),
            Path.Combine(temp.Path, "no-such-node")
        ).Describe();
        Assert.False(noBundle.Available);
        Assert.Contains("not installed", noBundle.Reason);
    }

    [Fact]
    public async Task Calls_without_a_runnable_host_fail_with_the_reason()
    {
        using var temp = new TempDirectory();
        await using var host = new BrowserHost(
            Path.Combine(temp.Path, "absent.cjs"),
            Path.Combine(temp.Path, "no-such-node")
        );
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            host.CallAsync("browser_tabs", new JsonObject(), CancellationToken.None)
        );
        Assert.Contains("not installed", error.Message);
    }

    [Fact]
    public void Describe_reports_the_contract_and_missing_browser_from_the_host()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var bundle = Path.Combine(temp.Path, "bundle.cjs");
        File.WriteAllText(bundle, "");
        var tool = """{"name":"browser_tabs","description":"d","parameters":{"type":"object","properties":{}}}""";
        var unavailable = new BrowserHost(
            bundle,
            DescribeScript(
                temp.Path,
                $$"""{"tools":[{{tool}}],"available":false,"reason":"No Chromium"}"""
            )
        ).Describe();
        Assert.False(unavailable.Available);
        Assert.Equal("No Chromium", unavailable.Reason);
        Assert.Equal("browser_tabs", unavailable.Tools[0]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void Description_is_the_shared_contract_without_stale_names()
    {
        if (BrowserHostFixture.BundlePath is null || BrowserHost.FindNode() is null)
            return;
        var names = new BrowserHost(BrowserHostFixture.BundlePath)
            .Describe()
            .Tools.Select(tool => tool!["name"]!.GetValue<string>())
            .ToArray();
        Assert.Equal(
            [
                "browser_tabs", "browser_open", "browser_close", "browser_navigate",
                "browser_read", "browser_screenshot", "browser_click", "browser_fill",
                "browser_type", "browser_press", "browser_select", "browser_scroll",
                "browser_wait", "browser_evaluate",
            ],
            names
        );
        var capabilities = Foxwarm.CliNode.NodeClient.Capabilities(
            browser: new BrowserHost(BrowserHostFixture.BundlePath).Describe().Tools
        );
        Assert.Contains(
            capabilities["tools"]!.AsArray(),
            tool => tool!["name"]!.GetValue<string>() == "browser_read"
        );
        Assert.DoesNotContain(
            Foxwarm.CliNode.NodeClient.Capabilities()["tools"]!.AsArray(),
            tool => tool!["name"]!.GetValue<string>().StartsWith("brows")
        );
    }

    [Fact]
    public async Task Real_host_drives_a_page_through_one_call_pipe()
    {
        if (!BrowserHostFixture.CanRunBrowser)
            return;
        await using var site = new BrowserHostFixture.Site(
            new() { ["/"] = Page, ["/second"] = "<title>Second</title>second" }
        );
        await using var host = new BrowserHost(BrowserHostFixture.BundlePath!);
        var token = CancellationToken.None;
        async Task<JsonObject> Call(string tool, string json) =>
            (JsonObject)(await host.CallAsync(tool, Args(json), token))!;

        var opened = await Call("browser_open", $$"""{"url":"{{site.Origin}}/"}""");
        var tab = opened["tabId"]!.GetValue<int>();
        Assert.Equal("Fixture", opened["title"]!.GetValue<string>());
        var snapshot = await Call("browser_read", $$"""{"tabId":{{tab}}}""");
        var entry = snapshot["elements"]!
            .AsArray()
            .First(item => item!["label"]!.GetValue<string>() == "Entry")!["ref"]!
            .GetValue<string>();
        var filled = await Call("browser_fill", $$"""{"tabId":{{tab}},"ref":"{{entry}}","text":"typed value"}""");
        Assert.True(filled["filled"]!.GetValue<bool>());
        Assert.False(filled["navigated"]!.GetValue<bool>());
        var mirror = await Call("browser_evaluate", $$"""{"tabId":{{tab}},"code":"document.getElementById('mirror').textContent"}""");
        Assert.Equal("mirror:typed value", mirror["result"]!.GetValue<string>());
        var clicked = await Call("browser_click", $$"""{"tabId":{{tab}},"selector":"#go"}""");
        Assert.True(clicked["clicked"]!.GetValue<bool>());
        var screenshot = await Call("browser_screenshot", $$"""{"tabId":{{tab}}}""");
        Assert.Equal("image/png", screenshot["inlineData"]!["mimeType"]!.GetValue<string>());
        Assert.StartsWith("iVBOR", screenshot["inlineData"]!["data"]!.GetValue<string>());
        var moved = await Call("browser_navigate", $$"""{"tabId":{{tab}},"url":"{{site.Origin}}/second"}""");
        Assert.True(moved["navigated"]!.GetValue<bool>());
        Assert.Equal("Second", moved["title"]!.GetValue<string>());
        var tabs = await Call("browser_tabs", "{}");
        Assert.Equal(site.Origin + "/second", tabs["tabs"]![0]!["url"]!.GetValue<string>());
        var rejected = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            host.CallAsync("browser_open", Args("""{"url":"file:///etc/hostname"}"""), token)
        );
        Assert.Contains("HTTP", rejected.Message);
        await Call("browser_close", $$"""{"tabId":{{tab}}}""");
        Assert.Empty((await Call("browser_tabs", "{}"))["tabs"]!.AsArray());
    }

    // A host connection whose answer to the cancel line is delivered inside the send itself, so
    // the reply is already processed when the caller's cancellation callback continues.
    private sealed class AnsweringConnection(Func<long, JsonObject> answerCancel)
        : BrowserHost.IHostConnection
    {
        private readonly object gate = new();
        private readonly Dictionary<long, TaskCompletionSource<JsonObject>> waiting = new();
        private readonly TaskCompletionSource callSent = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        internal List<JsonObject> Frames { get; } = [];

        internal Task CallSent => callSent.Task;

        public bool Exited => false;

        // Delivers a host reply to the one call in flight.
        internal void Reply(JsonObject reply)
        {
            lock (gate)
                waiting.Values.Single().TrySetResult(reply);
        }

        public void Add(long id, TaskCompletionSource<JsonObject> pending)
        {
            lock (gate)
                waiting[id] = pending;
        }

        public void Remove(long id)
        {
            lock (gate)
                waiting.Remove(id);
        }

        public Task Send(JsonObject message)
        {
            lock (gate)
                Frames.Add(message);
            if (message.ContainsKey("tool"))
                callSent.TrySetResult();
            return Task.CompletedTask;
        }

        public Task TrySend(JsonObject message)
        {
            _ = Send(message);
            if (message["cancel"]?.GetValue<long>() is long id)
            {
                TaskCompletionSource<JsonObject>? pending;
                lock (gate)
                    waiting.TryGetValue(id, out pending);
                pending?.TrySetResult(answerCancel(id));
            }
            return Task.CompletedTask;
        }

        public void Kill() { }

        public Task Close() => Task.CompletedTask;
    }

    [Fact]
    public async Task A_failed_reply_that_beats_the_cancellation_still_surfaces_as_cancellation()
    {
        var connection = new AnsweringConnection(id =>
            new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = "Browser call canceled." }
        );
        await using var host = new BrowserHost("unused") { ConnectionFactory = () => connection };
        using var stop = new CancellationTokenSource();
        var call = host.CallAsync("browser_open", Args("""{"url":"http://127.0.0.1/"}"""), stop.Token);
        await connection.CallSent;
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
        // The host still gets the cancel line, after the call it belongs to.
        var cancel = Assert.Single(connection.Frames, frame => frame.ContainsKey("cancel"));
        Assert.Equal(connection.Frames[0]["id"]!.GetValue<long>(), cancel["cancel"]!.GetValue<long>());
        Assert.Equal(2, connection.Frames.Count);
    }

    [Fact]
    public async Task A_host_failure_while_cancelling_still_surfaces_as_cancellation()
    {
        // The host dies and its pending calls fail before the caller's cancellation completes.
        var dying = new DyingOnCancelConnection();
        await using var host = new BrowserHost("unused") { ConnectionFactory = () => dying };
        using var stop = new CancellationTokenSource();
        var call = host.CallAsync("browser_open", Args("""{"url":"http://127.0.0.1/"}"""), stop.Token);
        await dying.CallSent;
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
    }

    private sealed class DyingOnCancelConnection : BrowserHost.IHostConnection
    {
        private TaskCompletionSource<JsonObject>? waiting;
        private readonly TaskCompletionSource callSent = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );

        internal Task CallSent => callSent.Task;

        public bool Exited => false;

        public void Add(long id, TaskCompletionSource<JsonObject> pending) => waiting = pending;

        public void Remove(long id) { }

        public Task Send(JsonObject message)
        {
            if (message.ContainsKey("tool"))
                callSent.TrySetResult();
            return Task.CompletedTask;
        }

        public Task TrySend(JsonObject message)
        {
            waiting?.TrySetException(new InvalidOperationException("The browser host stopped unexpectedly."));
            return Task.CompletedTask;
        }

        public void Kill() { }

        public Task Close() => Task.CompletedTask;
    }

    [Fact]
    public async Task A_failed_reply_without_cancellation_is_still_a_failure()
    {
        var connection = new AnsweringConnection(_ => new JsonObject());
        await using var host = new BrowserHost("unused") { ConnectionFactory = () => connection };
        var call = host.CallAsync("browser_open", Args("""{"url":"http://127.0.0.1/"}"""), CancellationToken.None);
        await connection.CallSent;
        connection.Reply(new JsonObject { ["ok"] = false, ["error"] = "Page crashed." });
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => call);
        Assert.Equal("Page crashed.", error.Message);
    }

    [Fact]
    public async Task Cancelling_a_call_reaches_the_host_and_leaves_it_usable()
    {
        if (!BrowserHostFixture.CanRunBrowser)
            return;
        await using var site = new BrowserHostFixture.Site(new() { ["/"] = Page });
        await using var host = new BrowserHost(BrowserHostFixture.BundlePath!);
        using var stop = new CancellationTokenSource();
        var started = DateTime.UtcNow;
        var pending = host.CallAsync(
            "browser_open",
            Args($$"""{"url":"{{site.Origin}}/stall"}"""),
            stop.Token
        );
        await Task.Delay(500);
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(10));
        // The host aborted the page it was opening; nothing is left tracked.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        JsonObject? tabs;
        do
        {
            tabs = (JsonObject?)
                await host.CallAsync("browser_tabs", new JsonObject(), CancellationToken.None);
            if (tabs!["tabs"]!.AsArray().Count == 0)
                break;
            await Task.Delay(100);
        } while (DateTime.UtcNow < deadline);
        Assert.Empty(tabs["tabs"]!.AsArray());
        var reopened = (JsonObject?)
            await host.CallAsync(
                "browser_open",
                Args($$"""{"url":"{{site.Origin}}/"}"""),
                CancellationToken.None
            );
        Assert.Equal("Fixture", reopened!["title"]!.GetValue<string>());
    }
}
