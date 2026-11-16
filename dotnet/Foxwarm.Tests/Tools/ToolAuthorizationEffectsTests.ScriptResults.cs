using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// What a self-exempt script may return: images in its own history and images its authorized
// nested calls produced in the same run (operation authorization phase 3).
public sealed partial class ToolAuthorizationEffectsTests
{
    private static async Task AppendImage(SessionOwner owner, JsonObject reference, string imageId)
    {
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["inlineDataRef"] = reference.DeepClone(),
                    ["imageMeta"] = new JsonObject { ["imageId"] = imageId },
                }
            ),
        };
        await owner.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                [message],
                [],
                updateLastMessageTime: false,
                finalizing: false,
                () => 1
            )
        );
    }

    // The bytes the next provider request would carry for a script result.

    private static async Task<byte[]?> Promoted(SessionManager manager, JsonObject result)
    {
        var message = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "script",
                        ["name"] = "run_script",
                        ["response"] = result.DeepClone(),
                    },
                }
            ),
        };
        await manager.Images.ExternalizeMessageAsync(message);
        var hydrated = await manager.Images.HydrateAsync([message], "openai-responses");
        var image = hydrated[0]["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .SingleOrDefault(part => part["inlineData"] is not null);
        return image is null
            ? null
            : Convert.FromBase64String(SessionWait.Text(image["inlineData"]!["data"])!);
    }

    [Fact]
    public async Task A_self_exempt_script_returns_only_images_it_can_reach()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        var foreign = await manager.Images.PutAsync(bytes, "image/png", "foreign-only");
        await AppendImage(await manager.RequiredAsync("foreign"), foreign, "foreign-only");
        var ownBytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 4, 3);
        var own = await manager.Images.PutAsync(ownBytes, "image/png", "own");
        await AppendImage(owner, own, "own");
        var producedBytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 5, 4);
        var produced = await manager.Images.PutAsync(producedBytes, "image/png", "produced");
        RegisterImageProducer(execution.Registry, produced);
        const string ReturnArgument = "return {'parts':[{'inlineDataRef':args['reference']}]}";

        // Version-1 deny-all: inline scripts are admitted, but a reference outside the caller's
        // history fails the run before anything reads the blob.
        await Policy(manager, "version: 1\ndefaultAction: deny\nrules: []\n");
        var rejected = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = ReturnArgument,
                ["args"] = new JsonObject { ["reference"] = foreign.DeepClone() },
            }
        );
        Assert.Contains("which it can't return", ScriptError(rejected));
        Assert.Null(rejected["imageParts"]);
        Assert.Null(await Promoted(manager, rejected));

        // The caller's own history image is admitted and reaches the next request.
        var admitted = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = ReturnArgument,
                ["args"] = new JsonObject { ["reference"] = own.DeepClone() },
            }
        );
        Assert.Equal("", ScriptError(admitted));
        Assert.NotNull(admitted["imageParts"]);
        Assert.Equal(ownBytes, await Promoted(manager, admitted));

        // An image a nested call produced in this run is admitted only when the call passed.
        const string Produce = FirstImage + "r = call_tool('produce_image', {})\nreturn {'parts':[{'inlineDataRef': first_image(r)}]}";
        var deniedNested = await Call(execution.Tools, "run_script", Obj($$"""{"code":{{JsonValue.Create(Produce)!.ToJsonString()}}}"""));
        Assert.Contains("denied", ScriptError(deniedNested));
        Assert.Null(deniedNested["imageParts"]);
        await Policy(manager, "version: 1\nrules: []\n");
        var nested = await Call(execution.Tools, "run_script", Obj($$"""{"code":{{JsonValue.Create(Produce)!.ToJsonString()}}}"""));
        Assert.Equal("", ScriptError(nested));
        Assert.Equal(producedBytes, await Promoted(manager, nested));
        // A reference produced in an earlier run is not this run's.
        var earlier = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = ReturnArgument,
                ["args"] = new JsonObject { ["reference"] = produced.DeepClone() },
            }
        );
        Assert.Contains("which it can't return", ScriptError(earlier));
    }

    // A script helper: the first image result of a nested call.
    private const string FirstImage =
        "def first_image(r):\n    for part in r.get('parts', []):\n        if 'inlineDataRef' in part:\n            return part['inlineDataRef']\n    return None\n";

    // Registers a builtin test tool that returns a stored image as an image result.
    private static void RegisterImageProducer(ToolRegistry registry, JsonObject reference) =>
        registry.Register(
            new JsonObject
            {
                ["name"] = "produce_image",
                ["description"] = "test",
                ["parameters"] = new JsonObject { ["type"] = "object" },
            },
            "builtin",
            false,
            (_, _, _) =>
                Task.FromResult(
                    new JsonObject
                    {
                        ["output"] = "made",
                        ["imageParts"] = new JsonArray(
                            new JsonObject { ["inlineDataRef"] = reference.DeepClone() }
                        ),
                    }
                )
        );

    // A reference that only passed through a nested result proves nothing produced it: echoed
    // data from self-exempt calls never counts, by call_tool, ctl or a background run. A nested
    // script's own returned images count, because they passed this same admission.
    [Fact]
    public async Task Nested_self_calls_do_not_launder_foreign_image_references()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var crop = MainLocalToolDefinitions
            .Definitions()
            .OfType<JsonObject>()
            .Single(item => SessionWait.Text(item["name"]) == "image_crop");
        execution.Registry.Register(
            crop,
            "builtin",
            false,
            (_, args, token) => manager.CropImageAsync(owner, args, token)
        );
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png);
        var foreign = await manager.Images.PutAsync(bytes, "image/png", "foreign-only");
        await AppendImage(await manager.RequiredAsync("foreign"), foreign, "foreign-only");
        var ownBytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 8, 6);
        var own = await manager.Images.PutAsync(ownBytes, "image/png", "own");
        await AppendImage(owner, own, "own");
        var producedBytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 5, 4);
        var produced = await manager.Images.PutAsync(producedBytes, "image/png", "produced");
        RegisterImageProducer(execution.Registry, produced);
        async Task<JsonObject> Run(string code) =>
            await Call(
                execution.Tools,
                "run_script",
                new JsonObject
                {
                    ["code"] = FirstImage + code,
                    ["args"] = new JsonObject { ["reference"] = foreign.DeepClone() },
                }
            );
        const string ReturnReference = "return {'parts':[{'inlineDataRef':args['reference']}]}";
        const string Echo = "return args['reference']";
        await Policy(manager, "version: 1\ndefaultAction: deny\nrules: []\n");
        var launders = new Dictionary<string, string>
        {
            // The reviewer's case: a nested inline script echoes the reference as data.
            ["call_tool"] =
                "call_tool('run_script', {'code': \"" + Echo + "\", 'args': {'reference': args['reference']}})\n",
            ["ctl"] =
                "ctl('script start --code @code --args @args', {'code': \"" + Echo + "\", 'args': {'reference': args['reference']}})\n",
            ["start_toolscript_run"] =
                "r = call_tool('start_toolscript_run', {'code': \"" + Echo + "\", 'args': {'reference': args['reference']}})\n"
                + "for i in range(200):\n    g = call_tool('get_toolscript_run', {'runId': r['runId']})\n    if g['status'] != 'running':\n        break\n",
            // A nested script returning it as an image part fails its own admission.
            ["nested image part"] =
                "call_tool('run_script', {'code': \"" + ReturnReference + "\", 'args': {'reference': args['reference']}})\n",
        };
        foreach (var (name, code) in launders)
        {
            var result = await Run(code + ReturnReference);
            Assert.True(ScriptError(result).Contains("which it can't return"), name + ": " + result.ToJsonString());
            Assert.Null(result["imageParts"]);
            Assert.Null(await Promoted(manager, result));
        }

        // Image results do count: a nested script returning an image its own authorized nested
        // call produced, and image_crop's new crop of the caller's own history image.
        await Policy(
            manager,
            "version: 1\ndefaultAction: deny\nrules:\n- {action: allow, match: {tool: {source: builtin, name: produce_image}}}\n"
        );
        const string Inner = "r = call_tool('produce_image', {})\nreturn {'parts':[{'inlineDataRef': first_image(r)}]}";
        var recursive = await Run(
            "r = call_tool('run_script', {'code': args['inner']})\nreturn {'parts':[{'inlineDataRef': first_image(r)}]}"
                .Replace("args['inner']", JsonValue.Create(FirstImage + Inner)!.ToJsonString())
        );
        Assert.Equal("", ScriptError(recursive));
        Assert.Equal(producedBytes, await Promoted(manager, recursive));
        var cropped = await Run(
            "r = call_tool({'toolId': 'builtin:image_crop'}, {'id': 'own', 'x': 0, 'y': 0, 'width': 2, 'height': 2})\nreturn {'parts':[{'inlineDataRef': first_image(r)}]}"
        );
        Assert.Equal("", ScriptError(cropped));
        var croppedBytes = await Promoted(manager, cropped);
        Assert.NotNull(croppedBytes);
        Assert.NotEqual(ownBytes, croppedBytes);
    }

    [Fact]
    public async Task Runs_completed_before_admission_keep_promoting_their_references()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("opaque");
        var execution = TimerExecutor(manager, owner, temp.Path);
        await using var mcp = execution.Mcp;
        var bytes = ImageCodecTests.Raster(SkiaSharp.SKEncodedImageFormat.Png, 6, 5);
        var foreign = await manager.Images.PutAsync(bytes, "image/png", "foreign-legacy");
        await AppendImage(await manager.RequiredAsync("foreign"), foreign, "foreign-legacy");
        await Policy(manager, "version: 1\nrules: []\n");
        var completed = await Call(execution.Tools, "run_script", Obj("""{"code":"return {'parts':[{'text':'done'}]}"}"""));
        var runId = SessionWait.Text(completed["runId"])!;

        // A legacy-shaped record: completed, a reference part, and no `resultImages` field.
        var record = (await manager.ToolScript.Store.ReadAsync(runId, default))!;
        Assert.True(record.ContainsKey("resultImages"));
        record.Remove("resultImages");
        record["lastResult"] = new JsonObject
        {
            ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = foreign.DeepClone() }),
        };
        await manager.ToolScript.Store.WriteAsync(record, default);
        var legacy = await Call(execution.Tools, "get_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.NotNull(legacy["imageParts"]);
        Assert.Equal(bytes, await Promoted(manager, legacy));

        // The same record with an admitted list from the new code promotes only what it lists.
        record["resultImages"] = new JsonArray();
        await manager.ToolScript.Store.WriteAsync(record, default);
        var admitted = await Call(execution.Tools, "get_toolscript_run", new JsonObject { ["runId"] = runId });
        Assert.Null(admitted["imageParts"]);

        // A new run returning the foreign reference is still rejected.
        var rejected = await Call(
            execution.Tools,
            "run_script",
            new JsonObject
            {
                ["code"] = "return {'parts':[{'inlineDataRef':args['reference']}]}",
                ["args"] = new JsonObject { ["reference"] = foreign.DeepClone() },
            }
        );
        Assert.Contains("which it can't return", ScriptError(rejected));
        Assert.Null(await Promoted(manager, rejected));
    }
}
