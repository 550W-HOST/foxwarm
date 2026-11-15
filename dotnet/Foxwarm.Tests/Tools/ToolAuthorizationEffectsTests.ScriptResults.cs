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
        execution.Registry.Register(
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
                        ["image"] = new JsonObject { ["inlineDataRef"] = produced.DeepClone() },
                    }
                )
        );
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
        const string Produce =
            "r = call_tool('produce_image', {})\nreturn {'parts':[{'inlineDataRef': r['image']['inlineDataRef']}]}";
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
}
