using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.BrowserSupport;
using Foxwarm.Sessions;
using PuppeteerSharp;

namespace Foxwarm.Tools;

// Main process state, shared across authorized Sessions. Image identities belong to the turn host.
internal sealed class MainBrowserTools(Func<LaunchOptions, Task<IBrowser>>? launcher = null)
    : IAsyncDisposable
{
    private readonly Func<LaunchOptions, Task<IBrowser>> launchBrowser =
        launcher ?? (options => Puppeteer.LaunchAsync(options));
    private IBrowser? browser;
    private readonly SemaphoreSlim launch = new(1, 1);
    private readonly object gate = new();
    private readonly OrderedDictionary<string, Tab> tabs = new();
    private int nextTabId = 1;

    private sealed record Tab(IPage Page, string Url, string Title);

    private const string Webdriver =
        "() => Object.defineProperty(navigator, 'webdriver', {get: () => false})";
    private const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private async Task<IBrowser> EnsureBrowser()
    {
        await launch.WaitAsync();
        try
        {
            if (browser is null)
            {
                browser = await launchBrowser(
                    new LaunchOptions
                    {
                        ExecutablePath = "/usr/bin/chromium",
                        Headless = true,
                        Args =
                        [
                            "--no-sandbox",
                            "--disable-setuid-sandbox",
                            "--disable-dev-shm-usage",
                            "--disable-gpu",
                            "--disable-blink-features=AutomationControlled",
                            "--disable-features=IsolateOrigins,site-per-process",
                        ],
                    }
                );
                foreach (var page in await browser.PagesAsync())
                    await page.EvaluateFunctionOnNewDocumentAsync(Webdriver);
            }
            return browser;
        }
        finally
        {
            launch.Release();
        }
    }

    private static NavigationOptions Navigation(int? timeout = null) =>
        new() { WaitUntil = [WaitUntilNavigation.Networkidle2], Timeout = timeout };

    private static string Required(JsonObject args, string key) =>
        ToolRegistry.Text(args, key) ?? throw new InvalidDataException(key + " is required.");

    private static bool Truthy(JsonNode? value) =>
        value is not null
        && (
            value is JsonObject or JsonArray
            || SessionWait.Text(value) is { Length: > 0 }
            || value is JsonValue flag && flag.TryGetValue<bool>(out var boolean) && boolean
            || SessionWait.Number(value) is double number && number != 0 && !double.IsNaN(number)
        );

    internal async Task<JsonNode?> Execute(string tool, JsonObject args)
    {
        try
        {
            return await ExecuteCore(tool, args);
        }
        catch (Exception error) when (error is PuppeteerException or ProcessException)
        {
            // SDK failures enter the existing local tool-error path, not the Main fatal path.
            throw new InvalidOperationException(error.Message, error);
        }
    }

    private async Task<JsonNode?> ExecuteCore(string tool, JsonObject args)
    {
        if (tool == "browse_list")
        {
            lock (gate)
                return JsonValue.Create(
                    tabs.Count == 0
                        ? "No tabs open"
                        : string.Join(
                            "\n\n",
                            tabs.Select(pair =>
                                pair.Key + ": " + pair.Value.Title + "\n  URL: " + pair.Value.Url
                            )
                        )
                );
        }
        if (tool == "browse_open")
        {
            var active = await EnsureBrowser();
            var url = Required(args, "url");
            var page = await active.NewPageAsync();
            await page.EvaluateFunctionOnNewDocumentAsync(Webdriver);
            await page.SetUserAgentAsync(UserAgent);
            await page.SetViewportAsync(new ViewPortOptions { Width = 1280, Height = 720 });
            await page.GoToAsync(url, Navigation(30000));
            var title = await page.GetTitleAsync();
            string id;
            lock (gate)
            {
                id = "tab" + (nextTabId++).ToString(CultureInfo.InvariantCulture);
                tabs.Add(id, new Tab(page, url, title));
            }
            return JsonValue.Create("Tab opened: " + id + "\nTitle: " + title + "\nURL: " + url);
        }
        var tabId = Required(args, "tabId");
        Tab tab;
        lock (gate)
            tab = tabs.TryGetValue(tabId, out var found)
                ? found
                : throw new InvalidDataException("Tab " + tabId + " not found");
        if (tool == "browse_close")
        {
            await tab.Page.CloseAsync();
            lock (gate)
                tabs.Remove(tabId);
            return JsonValue.Create("Tab " + tabId + " closed");
        }
        if (tool == "browse_get")
        {
            if (!Truthy(args["screenshot"]))
                return JsonValue.Create(
                    await tab.Page.EvaluateExpressionAsync<string>("document.body.innerText")
                );
            var bytes = await tab.Page.ScreenshotDataAsync(
                new ScreenshotOptions { Type = ScreenshotType.Png, FullPage = false }
            );
            if (SessionWait.Text(args["screenshot"]) is string path && path.StartsWith('/'))
            {
                // Source's raw browser capability: no ordinary file resolver, mkdir, sidecar or image grant.
                await File.WriteAllBytesAsync(path, bytes);
                return JsonValue.Create("Screenshot saved to: " + path);
            }
            return new JsonObject
            {
                ["output"] = "[Screenshot of " + tabId + "]",
                ["mimeType"] = "image/png",
                ["sizeBytes"] = bytes.Length,
                ["inlineData"] = new JsonObject
                {
                    ["data"] = Convert.ToBase64String(bytes),
                    ["mimeType"] = "image/png",
                },
            };
        }
        var action = Required(args, "action");
        var parameters = args["params"] as JsonObject ?? new JsonObject();
        string output;
        switch (action)
        {
            case "click":
                var selector = Required(parameters, "selector");
                await tab.Page.ClickAsync(selector);
                try
                {
                    await tab.Page.WaitForNavigationAsync(Navigation(5000));
                }
                catch (Exception error) when (error is PuppeteerException or TimeoutException) { }
                output = "Clicked: " + selector;
                break;
            case "type":
                selector = Required(parameters, "selector");
                var text = Required(parameters, "text");
                await tab.Page.TypeAsync(selector, text);
                output = "Typed \"" + text + "\" into " + selector;
                break;
            case "fill":
                selector = Required(parameters, "selector");
                text = Required(parameters, "text");
                await tab.Page.EvaluateFunctionAsync(
                    "(selector,text) => { const el=document.querySelector(selector); if(!el) throw new Error(`Selector not found: ${selector}`); el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); }",
                    selector,
                    text
                );
                output = "Filled " + selector + " with \"" + text + "\"";
                break;
            case "press":
                var key = Required(parameters, "key");
                await tab.Page.Keyboard.PressAsync(key);
                output = "Pressed key: " + key;
                break;
            case "scroll":
                var y = Truthy(parameters["y"]) ? SessionWait.Number(parameters["y"]) ?? 0 : 0;
                await tab.Page.EvaluateFunctionAsync("y => window.scrollBy(0,y)", y);
                output = "Scrolled by " + EcmaNumber.Format(y) + "px";
                break;
            case "wait":
                selector = Required(parameters, "selector");
                var timeout = Truthy(parameters["timeout"])
                    ? SessionWait.Number(parameters["timeout"]) ?? 5000
                    : 5000;
                await using (
                    await tab.Page.WaitForSelectorAsync(
                        selector,
                        new WaitForSelectorOptions { Timeout = (int)timeout }
                    )
                ) { }
                output = "Waited for: " + selector;
                break;
            case "evaluate":
                await using (
                    var value = await tab.Page.EvaluateExpressionHandleAsync(
                        Required(parameters, "code")
                    )
                )
                    output = "Evaluated: " + await BrowserEvaluation.StringifyResult(value);
                break;
            case "goto":
                var url = Required(parameters, "url");
                await tab.Page.GoToAsync(url, Navigation(30000));
                var title = await tab.Page.GetTitleAsync();
                lock (gate)
                    if (tabs.ContainsKey(tabId))
                        tabs[tabId] = tab with { Url = url, Title = title };
                output = "Navigated to: " + url + "\nTitle: " + title;
                break;
            case "back":
                await tab.Page.GoBackAsync(Navigation());
                output = "Navigated back";
                break;
            case "forward":
                await tab.Page.GoForwardAsync(Navigation());
                output = "Navigated forward";
                break;
            case "reload":
                await tab.Page.ReloadAsync(null, [WaitUntilNavigation.Networkidle2]);
                output = "Page reloaded";
                break;
            default:
                throw new InvalidDataException("Unknown action: " + action);
        }
        return JsonValue.Create(output);
    }

    public async ValueTask DisposeAsync()
    {
        if (browser is not null)
            await browser.DisposeAsync();
        launch.Dispose();
    }
}
