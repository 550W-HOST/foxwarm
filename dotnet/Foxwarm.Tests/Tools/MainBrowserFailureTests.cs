using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using PuppeteerSharp;

namespace Foxwarm.Tests;

public sealed class MainBrowserFailureTests
{
    [Fact]
    public async Task Sdk_launch_failure_is_paired_with_the_call_and_reaches_the_next_model_request()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var missingBrowser = Path.Combine(temp.Path, "missing-browser");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "browser", null, null);
        ProcessException? launchFailure = null;
        await using var browser = new MainBrowserTools(async launchOptions =>
        {
            launchOptions.ExecutablePath = missingBrowser;
            try
            {
                return await Puppeteer.LaunchAsync(launchOptions);
            }
            catch (ProcessException error)
            {
                launchFailure = error;
                throw;
            }
        });
        await using var mcp = new Foxwarm.McpClient(data);
        var registry = new ToolRegistry(mcp, _ => work);
        registry.Register(
            MainBrowserDefinitions
                .All()
                .OfType<JsonObject>()
                .Single(row => row["name"]!.GetValue<string>() == "browse_open"),
            "node",
            false,
            async (_, args, _) =>
                new JsonObject { ["output"] = await browser.Execute("browse_open", args) }
        );
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        var chat = new ControlledChat();
        chat.QueueChatResult(
            new ChatResult(
                new JsonObject
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionCall"] = new JsonObject
                            {
                                ["id"] = "browser-launch",
                                ["name"] = "browse_open",
                                ["args"] = new JsonObject { ["url"] = "http://127.0.0.1:1" },
                            },
                        }
                    ),
                }
            )
        );
        chat.QueueResult("Browser failure received");
        var host = new LocalSessionTurnHost(owner.Entry, owner.Registry.Store, chat, tools);
        Assert.True(await host.TryClaimBusyAsync());

        await host.ChatAsync("browser-launch");

        Assert.NotNull(launchFailure);
        Assert.Equal(2, chat.Calls.Count);
        var paired = Assert.Single(
            chat.Calls[1].History,
            row => row["role"]!.GetValue<string>() == "tool"
        );
        var response = Assert.Single(paired["parts"]!.AsArray())!["functionResponse"]!;
        Assert.Equal("browser-launch", response["tool_use_id"]!.GetValue<string>());
        Assert.Equal("browse_open", response["name"]!.GetValue<string>());
        Assert.Equal("tool_error", response["response"]!["error"]!["type"]!.GetValue<string>());
        Assert.Equal(
            launchFailure.Message,
            response["response"]!["error"]!["message"]!.GetValue<string>()
        );
        Assert.Equal(
            "Browser failure received",
            owner.History()[^1]["parts"]![0]!["text"]!.GetValue<string>()
        );
    }
}
