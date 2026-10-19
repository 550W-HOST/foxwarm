using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class NodePolicyCliTests
{
    private static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
    private static string? Error(JsonObject result) => SessionWait.Text(result["error"]?["type"]);

    [Fact]
    public async Task Official_CLI_actual_effect_policy_preserves_copy_image_delivery_exact_exec_owner_cwd_completion_and_external_MCP()
    {
        if (OperatingSystem.IsWindows())
            return; // This fixture qualifies the official POSIX CLI; native Windows has its own corpus.
        await using var f = await InboundMcpFixture.CreateAsync(allow: false);
        var repository = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var remote = Path.Combine(f.Temp.Path, "cli-agent");
        var cliCwd = Path.Combine(f.Temp.Path, "cli-cwd");
        Directory.CreateDirectory(remote);
        Directory.CreateDirectory(cliCwd);
        var credential = f.Manager.Nodes.Registry.Create("official");
        var config = Path.Combine(f.Temp.Path, "cli-options.json");
        await File.WriteAllTextAsync(config, new JsonObject
        {
            ["host"] = f.Url[..^4], ["nodeId"] = "official", ["authToken"] = credential["authToken"]!.DeepClone(),
            ["credentialsFile"] = Path.Combine(f.Temp.Path, "cli-credentials.json"), ["localTrigger"] = false,
        }.ToJsonString());
        var bootstrap = Path.Combine(f.Temp.Path, "cli.cjs");
        await File.WriteAllTextAsync(bootstrap, "const {NodeClient}=require(process.argv[2]); const fs=require('fs'); const client=new NodeClient({...JSON.parse(fs.readFileSync(process.argv[3],'utf8')),onStatus:event=>{if(event==='registered') console.log('READY')}}); client.connect().catch(e=>{console.error(e);process.exit(1)});");
        var info = new ProcessStartInfo("node") { WorkingDirectory = cliCwd, RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
        foreach (var arg in new[] { bootstrap, Path.Combine(repository, "packages", "cli-node", "dist", "client.js"), config })
            info.ArgumentList.Add(arg);
        info.Environment["FOXWARM_AGENT_DIR"] = remote;
        info.Environment["FOXWARM_DATA_DIR"] = Path.Combine(f.Temp.Path, "cli-data");
        info.Environment["FOXWARM_NO_CONSOLE_LOG"] = "1";
        using var cli = Process.Start(info)!;
        var stderr = cli.StandardError.ReadToEndAsync();
        try
        {
            Assert.Equal("READY", await cli.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)));
            Assert.True(f.Manager.Nodes.Connected("official"));
            await using var mcp = new Foxwarm.McpClient(f.Data);
            var definitions = WorkspaceTools.Definitions();
            foreach (var group in new[] { FileDeliveryDefinitions.Definitions(), UnifiedToolDefinitions.All(), NodeToolDefinitions.All(), LocalExecManager.Definitions(), ToolScriptToolDefinitions.Definitions() })
                foreach (var definition in group)
                    definitions.Add(definition?.DeepClone());
            var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => f.Work, f.Manager.Nodes);
            var tools = new SessionToolExecutor(new WorkspaceTools(f.Work), f.Target, f.Manager, registry);
            tools.BeginTurn();
            async Task<JsonObject> Call(string name, JsonObject args) => (await tools.ExecuteAsync(new JsonObject { ["id"] = Guid.NewGuid().ToString("N"), ["name"] = name, ["args"] = args }, default))!.AsObject();
            const string broad = "version: 1\ndefaultAction: deny\nrules:\n- action: allow\n  node: [master, official]\n";
            await f.PolicyAsync(broad);
            var source = Path.Combine(f.Work, "binary");
            byte[] bytes = [0, 1, 255, 128];
            await File.WriteAllBytesAsync(source, bytes);
            var copy = Obj("""{"sourceNode":"master","sourcePath":"binary","targetNode":"official","targetPath":"nested/copy.bin"}""");
            // An allow must cover both endpoints, even when the legacy routing target is master.
            await f.PolicyAsync("version: 1\ndefaultAction: deny\nrules: [{action: allow, node: official}]");
            Assert.Equal("tool_authorization_denied", Error(await Call("copy_between_nodes", copy.DeepClone().AsObject())));
            Assert.False(File.Exists(Path.Combine(remote, "nested/copy.bin")));
            await f.PolicyAsync(broad);
            Assert.Null(Error(await Call("copy_between_nodes", copy.DeepClone().AsObject())));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(remote, "nested/copy.bin")));
            var back = Obj("""{"sourceNode":"official","sourcePath":"nested/copy.bin","targetNode":"master","targetPath":"back.bin"}""");
            foreach (var denied in new[] { "master", "official" })
            {
                await f.PolicyAsync($"version: 1\nrules: [{{action: deny, node: {denied}}}]");
                Assert.Equal("tool_authorization_denied", Error(await Call("copy_between_nodes", back.DeepClone().AsObject())));
                Assert.False(File.Exists(Path.Combine(f.Work, "back.bin")));
            }
            await f.PolicyAsync(broad);
            Assert.Null(Error(await Call("copy_between_nodes", back.DeepClone().AsObject())));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "back.bin")));
            Assert.NotNull(Error(await Call("copy_between_nodes", back.DeepClone().AsObject())));

            var imageBytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
            var image = await f.Manager.Images.PutAsync(imageBytes, "image/png", "policy-image");
            await ForkClearLifecycleTests.AppendAsync(f.Target, new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = image.DeepClone() }) });
            await f.PolicyAsync("version: 1\ndefaultAction: deny\nrules: [{action: allow, node: official, tool: {source: builtin, name: image_write_to_file}}]");
            var export = await Call("image_write_to_file", Obj("""{"node":"official","id":"policy-image","filePath":"images/original.bin"}"""));
            Assert.Null(Error(export));
            Assert.Equal(imageBytes, await File.ReadAllBytesAsync(Path.Combine(remote, "images/original.bin")));
            Assert.Equal("tool_authorization_denied", Error(await Call("image_write_to_file", Obj("""{"node":"master","id":"policy-image","filePath":"denied-image"}"""))));
            f.Manager.AttachWebUi(f.Target.Id, f.Target);
            var deliveries = 0;
            f.Manager.RegisterWebUiFileDelivery((conversation, file, _) =>
            {
                Assert.Equal(f.Target.Id, conversation);
                Assert.Equal(imageBytes, File.ReadAllBytes(file));
                deliveries++;
            });
            await f.PolicyAsync("version: 1\ndefaultAction: deny\nrules: [{action: allow, node: official, tool: {source: builtin, name: send_file}}]");
            Assert.Null(Error(await Call("send_file", Obj("""{"node":"official","filePath":"images/original.bin"}"""))));
            Assert.Equal(1, deliveries);
            // Neither owned-image export nor delivery needs an invented ordinary Node read/write grant.
            Assert.Equal("tool_authorization_denied", Error(await Call("call_tool", Obj("""{"toolId":"node:official/read","args":{"filePath":"images/original.bin"}}"""))));

            await f.PolicyAsync(broad);
            Assert.Null(Error(await Call("node", Obj("""{"action":"inspect","nodeId":"official"}"""))));
            Assert.Null(Error(await Call("node", Obj("""{"action":"select","nodeId":"official"}"""))));
            await f.Target.UpdateCwdAsync(cliCwd);
            await f.PolicyAsync("""
                version: 1
                defaultAction: deny
                rules:
                - action: allow
                  node: {current: true}
                - action: allow
                  tool: {source: builtin, name: run_script}
                """);
            Assert.Null(Error(await Call("write", Obj("""{"filePath":"selected.txt","content":"selected"}"""))));
            Assert.Equal("selected", await File.ReadAllTextAsync(Path.Combine(cliCwd, "selected.txt")));
            Assert.Equal("tool_authorization_denied", Error(await Call("call_tool", Obj("""{"toolId":"node:master/write","args":{"filePath":"wrong-node","content":"no"}}"""))));
            Assert.False(File.Exists(Path.Combine(f.Work, "wrong-node")));
            var nested = await Call("run_script", Obj("""{"code":"return call_tool('read', {'filePath':'selected.txt'})['content']"}"""));
            Assert.Null(Error(nested));
            Assert.Equal("selected", nested["result"]!.GetValue<string>());
            // File source Node is not the VM placement or caller-current identity.
            await File.WriteAllTextAsync(Path.Combine(f.Work, "source.py"), "return call_tool('read', {'filePath':'selected.txt'})['content']");
            await f.PolicyAsync("""
                version: 1
                defaultAction: deny
                rules:
                - action: allow
                  node: {current: true}
                - action: allow
                  tool: {source: builtin, name: run_script}
                - action: allow
                  node: master
                  tool: {source: node, name: read}
                """);
            var sourced = await Call("run_script", new JsonObject { ["node"] = "master", ["filePath"] = Path.Combine(f.Work, "source.py") });
            Assert.True(Error(sourced) is null, sourced.ToJsonString());
            Assert.Equal("selected", sourced["result"]!.GetValue<string>());
            var next = Path.Combine(cliCwd, "next");
            Directory.CreateDirectory(next);
            var foreground = await Call("exec", Obj("""{"command":"cd next; pwd","timeout":5}"""));
            Assert.True(Error(foreground) is null, foreground.ToJsonString());
            Assert.Contains(next, foreground.ToJsonString());
            // Ordinary CLI protocol carries the exact input cwd; it has no foreground cwd-sync producer.
            Assert.Equal(cliCwd, f.Manager.ExecutionPlacement(f.Target).Cwd);
            var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            var registered = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            var originalRegistration = f.Manager.Nodes.BackgroundRegistration!;
            f.Manager.Nodes.BackgroundRegistration = async (node, message) =>
            {
                await originalRegistration(node, message);
                registered.TrySetResult(message);
            };
            var originalEvent = f.Manager.Nodes.SessionEvent!;
            f.Manager.Nodes.SessionEvent = async (node, message) =>
            {
                await originalEvent(node, message);
                if (SessionWait.Text(message["eventType"]) == "background") completion.TrySetResult(message);
            };
            var background = await Call("exec", Obj("""{"command":"sleep 2; printf once >> completed.txt","timeout":1}"""));
            Assert.Null(Error(background));
            var registration = await registered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var execId = SessionWait.Text(registration["execId"]);
            Assert.NotNull(execId);
            Assert.True(f.Manager.Nodes.ExecClaims.Has(f.Target, execId!));
            await f.PolicyAsync(broad);
            Assert.Null(Error(await Call("node", Obj("""{"action":"select","nodeId":"master"}"""))));
            var notice = await completion.Task.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Equal(f.Target.Id, SessionWait.Text(notice["sessionId"]));
            Assert.Equal(execId, SessionWait.Text(notice["execId"]));
            Assert.False(f.Manager.Nodes.ExecClaims.Has(f.Target, execId!));
            Assert.Equal("once", await File.ReadAllTextAsync(Path.Combine(cliCwd, "completed.txt")));
            Assert.Equal("master", f.Manager.CurrentNode(f.Target));
            Assert.Null(f.Manager.ExecutionPlacement(f.Target).Cwd);

            // Actual inbound SDK discovery and execution use verified external identity, not a Session/current-Node principal.
            await using var external = await f.ClientAsync();
            await f.PolicyAsync("version: 1\nrules: [{action: allow, externalId: alpha, node: {current: true}}]");
            var deniedExternal = await InboundMcpFixture.ConcreteAsync(external, "node:official/read", new JsonObject { ["filePath"] = Path.Combine(cliCwd, "selected.txt") });
            Assert.True(deniedExternal["isError"]!.GetValue<bool>());
            await f.PolicyAsync("version: 1\nrules: [{action: allow, externalId: alpha, node: {provider: authenticated-remote}}]");
            var discovery = await InboundMcpFixture.CallAsync(external, "foxwarm_discover", Obj("""{"sources":["node"],"limit":50}"""));
            Assert.True(discovery["isError"]?.GetValue<bool>() != true, discovery.ToJsonString());
            Assert.Contains("node:official/read", discovery.ToJsonString());
            var read = await InboundMcpFixture.ConcreteAsync(external, "node:official/read", new JsonObject { ["filePath"] = Path.Combine(cliCwd, "selected.txt") });
            Assert.False(read["isError"]?.GetValue<bool>() == true, read.ToJsonString());
            Assert.Contains("selected", read.ToJsonString());
            var selectedExternal = await InboundMcpFixture.CallAsync(external, "foxwarm_node", Obj("""{"action":"select","nodeId":"official"}"""));
            Assert.False(selectedExternal["isError"]?.GetValue<bool>() == true, selectedExternal.ToJsonString());
            var externalExec = await InboundMcpFixture.ConcreteAsync(external, "node:official/exec", Obj("""{"command":"pwd","timeout":5}"""));
            Assert.False(externalExec["isError"]?.GetValue<bool>() == true, externalExec.ToJsonString());
            Assert.Contains(cliCwd, externalExec.ToJsonString());
            await f.PolicyAsync("version: 1\nrules: [{action: allow, externalId: alpha, node: {current: true}}]");
            Assert.True((await InboundMcpFixture.ConcreteAsync(external, "node:official/read", new JsonObject { ["filePath"] = Path.Combine(cliCwd, "selected.txt") }))["isError"]!.GetValue<bool>());
            await f.PolicyAsync("version: 1\nrules: [{action: allow, externalId: alpha, node: {provider: authenticated-remote}}]");
            await using var other = await f.ClientAsync(InboundMcpFixture.Beta);
            Assert.True((await InboundMcpFixture.ConcreteAsync(other, "node:official/read", new JsonObject { ["filePath"] = Path.Combine(cliCwd, "selected.txt") }))["isError"]!.GetValue<bool>());
        }
        finally
        {
            if (!cli.HasExited) cli.Kill(entireProcessTree: true);
            await cli.WaitForExitAsync();
            Console.WriteLine("Official CLI diagnostics: " + await stderr);
        }
    }
}
