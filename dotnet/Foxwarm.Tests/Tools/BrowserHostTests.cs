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
