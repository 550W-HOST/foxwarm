using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    private static async Task<ClientWebSocket> ConnectProgrammaticResident(Fixture f)
    {
        var credential = f.Manager.Nodes.Registry.Create("resident");
        var socket = new ClientWebSocket();
        f.Sockets.Add(socket);
        await socket.ConnectAsync(
            new Uri(
                f.App.Urls.Single().Replace("http", "ws")
                    + "/node_ws?id=resident&auth="
                    + credential["authToken"]!.GetValue<string>()
            ),
            default
        );
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "node_register",
                ["nodeType"] = "cli-node",
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = new JsonArray(new JsonObject { ["name"] = "read" }),
                    ["features"] = new JsonObject { ["programmaticToolData"] = true },
                },
            }
        );
        Assert.Equal("registered", SessionWait.Text((await Fixture.Read(socket))["type"]));
        await f.Manager.SelectNodeAsync(f.Owner, "resident");
        return socket;
    }

    private static async Task<JsonNode> SourceReadReply(
        Fixture f,
        string file,
        bool programmatic = true
    )
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("FOXWARM_TS_ROOT is required for Source reads");
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(
            Path.Combine(
                root,
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "resident-source-fixture-ts.mjs"
            )
        );
        info.Environment["FOXWARM_DATA_DIR"] = f.Data;
        info.Environment["FOXWARM_AGENTS_DIR"] = Path.Combine(f.Data, "agents");
        using var child = Process.Start(info)!;
        await child.StandardInput.WriteAsync(
            new JsonObject { ["filePath"] = file, ["programmatic"] = programmatic }.ToJsonString()
        );
        child.StandardInput.Close();
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(child.ExitCode == 0, await errors);
        return JsonNode.Parse(await output)!;
    }

    private static SessionToolExecutor SourceTools(Fixture f, Foxwarm.McpClient mcp)
    {
        var definitions = ToolScriptToolDefinitions.Definitions();
        definitions.Add(ArtifactToolDefinition.Definition());
        var registry = SessionToolExecutor.CreateRegistry(
            definitions,
            mcp,
            _ => f.Work,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
        return new(new WorkspaceTools(f.Work), f.Owner, f.Manager, registry);
    }

    private static async Task ReplyToSourceRead(ClientWebSocket socket, JsonNode reply)
    {
        var call = await Fixture.Read(socket);
        Assert.Equal("tool_call", SessionWait.Text(call["type"]));
        Assert.Equal("read", SessionWait.Text(call["tool"]));
        Assert.True(call["programmatic"]!.GetValue<bool>());
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "tool_call_response",
                ["callId"] = call["callId"]!.DeepClone(),
                ["result"] = reply,
            }
        );
    }

    // An actual later file read is served if requested, so changed/missing-source regressions
    // expose their real consequence instead of merely timing out the test.
    private static async Task<(JsonObject Result, List<JsonObject> Transfers)> FinishSource(
        ClientWebSocket socket,
        Task<JsonNode?> running,
        string file
    )
    {
        var transfers = new List<JsonObject>();
        async Task Serve()
        {
            while (true)
            {
                var request = await Fixture.Read(socket);
                if (SessionWait.Text(request["type"]) == "pong")
                    return;
                Assert.Equal("file_read_request", SessionWait.Text(request["type"]));
                transfers.Add(request);
                if (File.Exists(file))
                    await Fixture.Send(
                        socket,
                        Fixture.Reply(request, await File.ReadAllBytesAsync(file))
                    );
                else
                    await Fixture.Send(
                        socket,
                        new JsonObject
                        {
                            ["type"] = "file_transfer_error",
                            ["transferId"] = request["transferId"]!.DeepClone(),
                            ["error"] = "ENOENT: source was removed after the approved read",
                        }
                    );
            }
        }
        var serving = Serve();
        var result = (await running.WaitAsync(TimeSpan.FromSeconds(20)))!.AsObject();
        await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
        await serving;
        return (result, transfers);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Complete_Source_resident_reply_runs_original_contents_without_a_second_transfer(
        bool replace
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        await f.Owner.UpdateCwdAsync(f.Work);
        var file = Path.Combine(f.Work, "source.py");
        await File.WriteAllTextAsync(file, "return 73");
        var reply = await SourceReadReply(f, file);
        Assert.Equal("return 73", SessionWait.Text(reply["content"]));
        Assert.False(reply["truncated"]!.GetValue<bool>());
        Assert.Equal(9, SessionWait.Number(reply["sizeBytes"]));
        Assert.Equal(9, SessionWait.Number(reply["selectedBytes"]));
        if (replace)
            await File.WriteAllTextAsync(file, "return 99");
        else
            File.Delete(file);
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "run_script",
                ["args"] = new JsonObject { ["filePath"] = "source.py" },
            },
            default
        );
        var read = await Fixture.Read(socket);
        Assert.Equal("read", SessionWait.Text(read["tool"]));
        Assert.True(read["programmatic"]!.GetValue<bool>());
        Assert.Equal(f.Work, SessionWait.Text(read["sessionCwd"]));
        await f.Manager.SelectNodeAsync(f.Owner, "master");
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "tool_call_response",
                ["callId"] = read["callId"]!.DeepClone(),
                ["result"] = reply,
            }
        );
        var (result, transfers) = await FinishSource(socket, running, file);
        Assert.Null(result["error"]);
        Assert.Equal("completed", SessionWait.Text(result["status"]));
        Assert.Equal(73, result["result"]!.GetValue<int>());
        Assert.Empty(transfers);
        var saved = await f.Manager.ToolScript.Store.ReadAsync(
            SessionWait.Text(result["runId"])!,
            default
        );
        Assert.Equal(file, SessionWait.Text(saved!["scriptPath"]));
        Assert.Equal("resident", SessionWait.Text(saved["sourceNode"]));
    }

    [Fact]
    public async Task Complete_resident_source_continuation_keeps_original_code_without_refetch()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "source.py");
        await File.WriteAllTextAsync(file, "ask_agent('continue?')\nreturn 73");
        var reply = await SourceReadReply(f, file);
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "run_script",
                ["args"] = new JsonObject { ["filePath"] = "source.py" },
            },
            default
        );
        await ReplyToSourceRead(socket, reply);
        var (waiting, transfers) = await FinishSource(socket, running, file);
        Assert.Equal("waiting", SessionWait.Text(waiting["status"]));
        Assert.Empty(transfers);
        File.Delete(file);
        await f.Manager.SelectNodeAsync(f.Owner, "master");
        var continued = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "continue_script",
                ["args"] = new JsonObject
                {
                    ["runId"] = waiting["runId"]!.DeepClone(),
                    ["continuationId"] = waiting["continuationId"]!.DeepClone(),
                    ["input"] = "yes",
                },
            },
            default
        );
        var (done, laterTransfers) = await FinishSource(socket, continued, file);
        Assert.Null(done["error"]);
        Assert.Equal(73, done["result"]!.GetValue<int>());
        Assert.Empty(laterTransfers);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Actual_Source_incomplete_or_display_read_uses_correlated_transfer(
        bool programmatic
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "source.py");
        // The ordinary Source reader previews files above its complete-text bound.
        var code = programmatic ? "#" + new string('x', 1024 * 1024) + "\nreturn 73" : "return 73";
        await File.WriteAllTextAsync(file, code);
        var reply = await SourceReadReply(f, file, programmatic);
        if (programmatic)
        {
            Assert.True(reply["truncated"]!.GetValue<bool>());
            Assert.Null(reply["content"]);
        }
        else
            Assert.IsAssignableFrom<JsonValue>(reply);
        // Display-only replies lack path metadata; this exercises the captured-cwd fallback.
        await f.Owner.UpdateCwdAsync(f.Work);
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "run_script",
                ["args"] = new JsonObject { ["filePath"] = "source.py" },
            },
            default
        );
        await ReplyToSourceRead(socket, reply);
        var (result, transfers) = await FinishSource(socket, running, file);
        Assert.Null(result["error"]);
        Assert.Equal(73, result["result"]!.GetValue<int>());
        Assert.Equal(file, SessionWait.Text(Assert.Single(transfers)["filePath"]));
    }

    [Fact]
    public async Task Complete_resident_manifest_uses_actual_Source_content_without_rereading()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "chart.json");
        await File.WriteAllTextAsync(
            file,
            ArtifactStoreTests.Chart("Complete read").ToJsonString()
        );
        var reply = await SourceReadReply(f, file);
        File.Delete(file);
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "artifact",
                ["args"] = new JsonObject { ["action"] = "prepare", ["filePath"] = "chart.json" },
            },
            default
        );
        await ReplyToSourceRead(socket, reply);
        var (result, transfers) = await FinishSource(socket, running, file);
        Assert.Null(result["error"]);
        Assert.Equal("Complete read", SessionWait.Text(result["preparedArtifact"]?["title"]));
        Assert.Empty(transfers);
    }

    [Fact]
    public async Task Resident_image_reply_still_transfers_original_binary_artifact_bytes()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "image.png");
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        await File.WriteAllBytesAsync(file, bytes);
        var reply = await SourceReadReply(f, file);
        Assert.NotNull(reply["inlineData"]);
        Assert.Null(reply["content"]);
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "artifact",
                ["args"] = new JsonObject
                {
                    ["action"] = "prepare",
                    ["filePath"] = "image.png",
                    ["type"] = "image",
                },
            },
            default
        );
        await ReplyToSourceRead(socket, reply);
        var (result, transfers) = await FinishSource(socket, running, file);
        Assert.Null(result["error"]);
        Assert.Single(transfers);
        var id = SessionWait.Text(result["preparedArtifact"]?["artifactId"])!;
        var resource = await f.Manager.Artifacts.ResourceAsync(id, 1, f.Owner.Id, "image", default);
        Assert.Equal(bytes, resource.Bytes);
    }

    [Fact]
    public async Task Complete_content_charges_actual_UTF8_bytes_not_the_Source_file_size_metadata()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "invalid-utf8.txt");
        // Source's real small-text read decodes this byte with replacement. Its complete
        // content encodes to three bytes, although the original file metadata says one.
        await File.WriteAllBytesAsync(file, [255]);
        var reply = await SourceReadReply(f, file);
        Assert.Equal("\ufffd", SessionWait.Text(reply["content"]));
        Assert.Equal(1, SessionWait.Number(reply["sizeBytes"]));
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var budget = new Foxwarm.ToolScript.ToolScriptDataBudget(1);
        long charged = 0;
        var reader = typeof(SessionToolExecutor).GetMethod(
            "ReadResidentSourceAsync",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance
        )!;
        var running =
            (Task<Foxwarm.Nodes.NodeConnectionHub.TransferFile>)
                reader.Invoke(
                    tools,
                    [
                        "resident",
                        "invalid-utf8.txt",
                        null,
                        new WorkspaceTools(f.Work),
                        CancellationToken.None,
                        new Action<long>(size =>
                        {
                            charged = size;
                            budget.Charge(size);
                        }),
                    ]
                )!;
        await ReplyToSourceRead(socket, reply);
        await Assert.ThrowsAsync<Foxwarm.ToolScript.ToolScriptDataLimitException>(async () =>
            await running
        );
        Assert.Equal(3, charged);
        await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", SessionWait.Text((await Fixture.Read(socket))["type"]));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Resident_source_policy_or_interactive_read_denial_never_starts_transfer(
        bool policy
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        if (policy)
        {
            await File.WriteAllTextAsync(
                Path.Combine(f.Data, "state", "tool-authorization.yaml"),
                "version: 1\ndefaultAction: allow\nrules:\n- id: source-read\n  action: deny\n  match:\n    tool: {source: node, name: read}\n    targetNode: resident\n"
            );
            f.Manager.Authorization.Invalidate();
        }
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "run_script",
                ["args"] = new JsonObject { ["filePath"] = "source.py" },
            },
            default
        );
        if (!policy)
        {
            var read = await Fixture.Read(socket);
            Assert.Equal("tool_call", SessionWait.Text(read["type"]));
            await Fixture.Send(
                socket,
                new JsonObject
                {
                    ["type"] = "tool_call_error",
                    ["callId"] = read["callId"]!.DeepClone(),
                    ["error"] = "Interactive read rejected",
                }
            );
        }
        var result = (await running.WaitAsync(TimeSpan.FromSeconds(10)))!.AsObject();
        Assert.NotNull(result["error"]);
        await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", SessionWait.Text((await Fixture.Read(socket))["type"]));
    }

    [Fact]
    public async Task Resident_artifact_real_preview_transfer_retains_the_manifest_byte_limit()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectProgrammaticResident(f);
        var file = Path.Combine(f.Work, "large.json");
        await File.WriteAllTextAsync(
            file,
            "{" + new string(' ', ArtifactStore.ManifestLimit) + "}"
        );
        var reply = await SourceReadReply(f, file);
        Assert.True(reply["truncated"]!.GetValue<bool>());
        await using var mcp = new Foxwarm.McpClient(f.Data);
        var tools = SourceTools(f, mcp);
        var running = tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "artifact",
                ["args"] = new JsonObject { ["action"] = "prepare", ["filePath"] = "large.json" },
            },
            default
        );
        await ReplyToSourceRead(socket, reply);
        var (result, transfers) = await FinishSource(socket, running, file);
        Assert.Single(transfers);
        Assert.Contains("Artifact exceeds 2 MiB", result["error"]!.ToJsonString());
    }
}
