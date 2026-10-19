using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using PuppeteerSharp;
using PuppeteerSharp.Cdp;
using PuppeteerSharp.Cdp.Messaging;

namespace Foxwarm.CliNode;

// Process-owned CLI browser state; Session policy and image registration stay in Main.
internal sealed class NodeBrowserTools : IAsyncDisposable
{
    private IBrowser? browser;
    private readonly Dictionary<string, Tab> tabs = new();

    private sealed class Tab(IPage page, string url, string title)
    {
        internal IPage Page = page;
        internal string Url = url;
        internal string Title = title;
    }

    private async Task<IBrowser> EnsureBrowser()
    {
        if (browser is not null)
            return browser;
        var executable = Environment.GetEnvironmentVariable("PUPPETEER_EXECUTABLE_PATH");
        if (string.IsNullOrEmpty(executable))
            executable = Environment.GetEnvironmentVariable("CHROME_PATH");
        browser = await Puppeteer.LaunchAsync(
            new LaunchOptions
            {
                ExecutablePath = string.IsNullOrEmpty(executable)
                    ? "/usr/bin/chromium-browser"
                    : executable,
                Headless = true,
                Args = ["--no-sandbox", "--disable-setuid-sandbox"],
            }
        );
        return browser;
    }

    private static NavigationOptions Navigation(int? timeout = null) =>
        new() { WaitUntil = [WaitUntilNavigation.Networkidle2], Timeout = timeout };

    private static string String(JsonNode? value) =>
        value is null
            ? "null"
            : NodeFileTools.Text(value)
                ?? (value is JsonObject ? "[object Object]" : value.ToJsonString());

    private static string FallbackString(JsonNode? value) => Truthy(value) ? String(value) : "";

    private static double Number(JsonNode? value) =>
        double.TryParse(
            String(value),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out var result
        )
            ? result
            : 0;

    private static bool Truthy(JsonNode? value) =>
        value is not null
        && value.ToJsonString() is not "false" and not "null" and not "0" and not "\"\"";

    internal async Task<JsonNode> Execute(string tool, JsonObject? args)
    {
        args ??= new JsonObject();
        if (tool == "browse_list")
            return new JsonArray(
                tabs.Select(pair => (JsonNode)Metadata(pair.Key, pair.Value)).ToArray()
            );
        if (tool == "browse_open")
        {
            var active = await EnsureBrowser();
            var url = FallbackString(args["url"]);
            var page = await active.NewPageAsync();
            await page.GoToAsync(url, Navigation(30000));
            var id =
                "tab_"
                + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                + "_"
                + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));
            var title = await page.GetTitleAsync();
            tabs.Add(id, new Tab(page, url, title));
            return new JsonObject
            {
                ["tabId"] = id,
                ["url"] = url,
                ["title"] = title,
            };
        }
        var tabId = FallbackString(args["tabId"]);
        if (!tabs.TryGetValue(tabId, out var tab))
            throw new InvalidDataException("Tab " + tabId + " not found");
        if (tool == "browse_close")
        {
            await tab.Page.CloseAsync();
            tabs.Remove(tabId);
            return new JsonObject { ["output"] = "Tab " + tabId + " closed" };
        }
        if (tool == "browse_get")
        {
            tab.Url = tab.Page.Url;
            tab.Title = await tab.Page.GetTitleAsync();
            var result = Metadata(tabId, tab);
            if (!Truthy(args["screenshot"]))
                result["content"] = await tab.Page.GetContentAsync();
            else
            {
                var bytes = await tab.Page.ScreenshotDataAsync(
                    new ScreenshotOptions
                    {
                        Type = ScreenshotType.Png,
                        FullPage = NodeFileTools.Text(args["screenshot"]) == "full",
                    }
                );
                result["output"] = "[Screenshot of " + tabId + "]";
                result["mimeType"] = "image/png";
                result["sizeBytes"] = bytes.Length;
                result["inlineData"] = new JsonObject
                {
                    ["data"] = Convert.ToBase64String(bytes),
                    ["mimeType"] = "image/png",
                };
            }
            return result;
        }
        var action = FallbackString(args["action"]);
        var parameters = args["params"] as JsonObject ?? new JsonObject();
        var selector = NodeFileTools.Text(parameters["selector"])!;
        string output;
        switch (action)
        {
            case "click":
                await tab.Page.ClickAsync(selector);
                try
                {
                    await tab.Page.WaitForNavigationAsync(Navigation(5000));
                }
                catch
                {
                    // Source deliberately ignores this post-click navigation timeout.
                }
                output = "Clicked: " + selector;
                break;
            case "type":
                await tab.Page.TypeAsync(selector, NodeFileTools.Text(parameters["text"])!);
                output = "Typed into " + selector;
                break;
            case "fill":
                await tab.Page.EvaluateFunctionAsync(
                    "(selector,text) => { const el=document.querySelector(selector); if(!el) throw new Error(`Selector not found: ${selector}`); el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); }",
                    selector,
                    NodeFileTools.Text(parameters["text"])!
                );
                output = "Filled " + selector;
                break;
            case "press":
                var key = NodeFileTools.Text(parameters["key"])!;
                await tab.Page.Keyboard.PressAsync(key);
                output = "Pressed key: " + key;
                break;
            case "scroll":
                var y = Truthy(parameters["y"]) ? Number(parameters["y"]) : 0;
                await tab.Page.EvaluateFunctionAsync("y => window.scrollBy(0,y)", y);
                output =
                    "Scrolled by "
                    + (Truthy(parameters["y"]) ? String(parameters["y"]) : "0")
                    + "px";
                break;
            case "wait":
                var timeout = Truthy(parameters["timeout"]) ? Number(parameters["timeout"]) : 5000;
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
                        NodeFileTools.Text(parameters["code"])!
                    )
                )
                    output = "Evaluated: " + await StringifyResult(tab.Page, value);
                break;
            case "goto":
                var url = NodeFileTools.Text(parameters["url"])!;
                await tab.Page.GoToAsync(url, Navigation(30000));
                tab.Url = url;
                tab.Title = await tab.Page.GetTitleAsync();
                output = "Navigated to: " + url + "\nTitle: " + tab.Title;
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
        return new JsonObject { ["output"] = output };
    }

    // Preserve Puppeteer's return-by-value clone before JavaScript JSON.stringify.
    // Directly stringifying the live handle would call Date.toJSON and differ from Source.
    private static async Task<string> StringifyResult(IPage page, IJSHandle value)
    {
        var remote = ((ICdpHandle)value).RemoteObject;
        if (remote.Type == RemoteObjectType.Undefined)
            return "undefined";
        if (remote.Type == RemoteObjectType.Bigint)
            throw new InvalidDataException("Do not know how to serialize a BigInt");
        if (remote.UnserializableValue is not null)
            return remote.UnserializableValue == "-0" ? "0" : "null";
        JsonElement? cloned;
        try
        {
            cloned = await value.JsonValueAsync<JsonElement?>();
        }
        catch (PuppeteerException error)
            when (error.Message.Contains(
                    "Could not serialize referenced object",
                    StringComparison.Ordinal
                )
            )
        {
            return "undefined";
        }
        if (cloned is null)
            return "null";
        return await page.EvaluateFunctionAsync<string>(
            "text => JSON.stringify(JSON.parse(text))",
            cloned.Value.GetRawText()
        );
    }

    private static JsonObject Metadata(string id, Tab tab) =>
        new()
        {
            ["id"] = id,
            ["url"] = tab.Url,
            ["title"] = tab.Title,
        };

    public async ValueTask DisposeAsync()
    {
        if (browser is not null)
            await browser.DisposeAsync();
    }
}
