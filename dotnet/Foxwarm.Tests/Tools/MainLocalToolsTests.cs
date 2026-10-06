using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class MainLocalToolsTests
{
    private static string? Error(JsonObject result) => SessionWait.Text(result["error"]?["type"]);
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new(); internal SessionManager Manager = null!; internal SessionOwner Owner = null!; internal SessionToolExecutor Tools = null!; private Foxwarm.McpClient mcp = null!;
        internal static async Task<Fixture> Create()
        {
            var f = new Fixture(); var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
            f.Manager = new(Path.Combine(f.Temp.Path, "data"), Path.Combine(f.Temp.Path, "work"), options, HostModels.ForTest(options)); await f.Manager.LoadAsync(); f.Owner = await f.Manager.CreateNamedAsync("main", "tools", null, null);
            f.mcp = new(Path.Combine(f.Temp.Path, "data"));
            var defs = MainLocalToolDefinitions.Definitions();
            foreach (var definition in FileDeliveryDefinitions.Definitions().OfType<JsonObject>()) defs.Add(definition.DeepClone());
            foreach (var definition in UnifiedToolDefinitions.All().OfType<JsonObject>()) defs.Add(definition.DeepClone());
            var workspace = f.Manager.IdentityWorkspace(f.Owner)!;
            var toolRoot = workspace.ToolDirectory;
            var registry = SessionToolExecutor.CreateRegistry(defs, f.mcp, _ => toolRoot);
            f.Tools = new(new WorkspaceTools(toolRoot), f.Owner, f.Manager, registry); f.Tools.BeginTurn(); return f;
        }
        internal Task<JsonObject> Call(string name, JsonObject args) => Tools.ExecuteAsync(new JsonObject { ["id"] = Guid.NewGuid().ToString("N"), ["name"] = name, ["args"] = args }, default);
        public async ValueTask DisposeAsync() { await mcp.DisposeAsync(); await Manager.DisposeAsync(); Temp.Dispose(); }
    }

    [Fact]
    public async Task Memory_tools_use_agent_namespace_and_actual_mutations()
    {
        await using var f = await Fixture.Create(); var memory = f.Manager.MemoryDirectory(f.Owner.Agent); var created = await f.Call("write_memory", new JsonObject { ["filePath"] = "notes/item.md", ["content"] = "one\n" }); Assert.Null(Error(created));
        Assert.Equal("one\n", await File.ReadAllTextAsync(Path.Combine(memory, "notes", "item.md"))); Assert.Contains("one", (await f.Call("read_memory", new JsonObject { ["filePath"] = "memory/notes/item.md" }))["output"]!.ToString());
        Assert.Null(Error(await f.Call("edit_memory", new JsonObject { ["filePath"] = "notes/item.md", ["oldText"] = "one", ["newText"] = "two" })));
        Assert.Null(Error(await f.Call("apply_patch_memory", new JsonObject { ["input"] = "*** Begin Patch\n*** Add File: notes/added.md\n+added\n*** End Patch" })));
        Assert.Null(Error(await f.Call("delete_memory", new JsonObject { ["filePath"] = "notes/item.md" }))); Assert.False(File.Exists(Path.Combine(memory, "notes", "item.md"))); Assert.True(File.Exists(Path.Combine(memory, "notes", "added.md")));
        Assert.NotNull(Error(await f.Call("write_memory", new JsonObject { ["filePath"] = "notes/added.md", ["content"] = "again" })));
        var outside = Path.Combine(f.Temp.Path, "outside"); await File.WriteAllTextAsync(outside, "secret"); File.CreateSymbolicLink(Path.Combine(memory, "link.md"), outside); Assert.NotNull(Error(await f.Call("read_memory", new JsonObject { ["filePath"] = "link.md" })));
        await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes("version: 1\ndefaultAction: allow\nrules:\n- id: deny-memory\n  action: deny\n  match: {tool: {source: builtin, name: write_memory}}"), CancellationToken.None);
        var denied = await f.Call("write_memory", new JsonObject { ["filePath"] = "notes/denied.md", ["content"] = "no" }); Assert.Equal("tool_authorization_denied", Error(denied)); Assert.False(File.Exists(Path.Combine(memory, "notes", "denied.md")));
        var unified = await f.Call("call_tool", new JsonObject { ["source"] = "builtin", ["name"] = "read_memory", ["args"] = new JsonObject { ["filePath"] = "notes/added.md" } }); Assert.Null(Error(unified));
    }

    [Fact]
    public async Task List_agents_reports_catalog_without_hydrating_new_main()
    { await using var f = await Fixture.Create(); var result = await f.Call("list_agents", new JsonObject()); Assert.Null(Error(result)); Assert.Contains("**main**", result["output"]!.GetValue<string>()); }

    [Fact]
    public async Task Image_crop_is_session_owned_and_can_be_saved()
    {
        await using var f = await Fixture.Create(); var source = await f.Manager.Images.PutAsync(ImageCodecTests.Raster(SKEncodedImageFormat.Png), "image/png", "source"); await ForkClearLifecycleTests.AppendAsync(f.Owner, new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["imageMeta"] = new JsonObject { ["imageId"] = "source" }, ["inlineDataRef"] = source }) });
        var cropped = await f.Call("image_crop", new JsonObject { ["id"] = "source", ["x"] = 0, ["y"] = 0, ["width"] = 1, ["height"] = 1 }); Assert.Null(Error(cropped)); Assert.Equal(1, cropped["crop"]!["width"]!.GetValue<int>());
        var carrier = new JsonObject { ["role"] = "tool", ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = new JsonObject { ["tool_use_id"] = "crop", ["name"] = "image_crop", ["response"] = cropped } }) }; await f.Manager.Images.ExternalizeMessageAsync(carrier); await ForkClearLifecycleTests.AppendAsync(f.Owner, carrier); var path = Path.Combine(f.Manager.IdentityWorkspace(f.Owner)!.ToolDirectory, "cropped.png"); Assert.Null(Error(await f.Call("image_write_to_file", new JsonObject { ["id"] = "crop#1", ["filePath"] = path }))); Assert.True(File.Exists(path)); Assert.NotNull(Error(await f.Call("image_crop", new JsonObject { ["id"] = "not-owned", ["x"] = 0, ["y"] = 0, ["width"] = 1, ["height"] = 1 })));
    }
}