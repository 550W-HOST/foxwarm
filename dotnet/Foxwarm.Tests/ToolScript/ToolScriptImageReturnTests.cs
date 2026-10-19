using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;
using ScriptFixture = Foxwarm.Tests.MainToolScriptTests.Fixture;

namespace Foxwarm.Tests;

public sealed class ToolScriptImageReturnTests
{
    [Theory]
    [InlineData("inlineData")]
    [InlineData("inlineDataItems")]
    [InlineData("parts")]
    public async Task Real_read_and_native_return_promote_only_top_level_images_into_outer_provider_path(string carrier)
    {
        await using var f = await ScriptFixture.Create();
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, "image.dat"), bytes);
        var read = await f.Call("read", new JsonObject { ["filePath"] = "image.dat" });
        Assert.Equal("image/png", SessionWait.Text(read["mimeType"]));
        var reference = await f.Manager.Images.PutAsync(bytes, "image/png", "canonical");
        var code = carrier switch
        {
            "inlineData" => "image=args['image']\nreturn {'inlineData':image, 'business':args['business'], 'nested':{'inlineData':image}}",
            "inlineDataItems" => "image=args['image']\nreturn {'inlineDataItems':[image,image], 'business':args['business']}",
            _ => "return {'parts':[{'text':'caption'}, {'inlineDataRef':args['reference'], 'text':'retained'}], 'business':args['business']}",
        };
        var business = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["business"] = "unchanged" }), ["value"] = 42 };
        var completed = await f.Call("run_script", new JsonObject { ["code"] = code, ["args"] = new JsonObject { ["business"] = business.DeepClone(), ["reference"] = reference, ["image"] = read["inlineData"]!.DeepClone() } });
        Assert.Equal("completed", SessionWait.Text(completed["status"]));
        Assert.True(JsonNode.DeepEquals(business, completed["result"]!["business"]));
        Assert.Contains("promoted", completed["result"]![carrier]!.ToString());
        if (carrier == "inlineData") Assert.NotNull(completed["result"]!["nested"]!["inlineData"]);
        var message = new JsonObject { ["role"] = "tool", ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = new JsonObject { ["tool_use_id"] = "outer-image", ["name"] = "run_script", ["response"] = completed.DeepClone() } }) };
        await f.Manager.Images.ExternalizeMessageAsync(message);
        var images = message["parts"]!.AsArray().Skip(1).ToArray();
        Assert.Equal(carrier == "inlineDataItems" ? 2 : 1, images.Length);
        Assert.All(images, image => Assert.Equal("outer-image", SessionWait.Text(image!["toolUseId"])));
        foreach (var image in images) Assert.Equal(bytes, await f.Manager.Images.ReadAsync(image!["inlineDataRef"]!.AsObject()));
        var hydrated = await f.Manager.Images.HydrateAsync([message], "openai-responses");
        Assert.NotNull(hydrated[0]["parts"]![1]!["inlineData"]);
        var wire = ResponsesRequestSerializer.ConvertHistoryWithImages(hydrated, "fixture/wire", f.Manager.Images);
        Assert.Contains("input_image", wire.ToJsonString());
        var persisted = (await f.Manager.ToolScript.Store.ReadAsync(SessionWait.Text(completed["runId"])!, default))!;
        Assert.True(JsonNode.DeepEquals(business, persisted["lastResult"]!["business"]));
    }

    [Theory]
    [InlineData("no-extension")]
    [InlineData("wrong.jpg")]
    public async Task Native_read_uses_header_and_text_with_image_extension_remains_text(string name)
    {
        await using var f = await ScriptFixture.Create();
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        await File.WriteAllBytesAsync(Path.Combine(f.Work, name), bytes);
        var image = await f.Call("read", new JsonObject { ["filePath"] = name });
        Assert.Equal("image/png", SessionWait.Text(image["inlineData"]!["mimeType"]));
        Assert.Equal(bytes, Convert.FromBase64String(SessionWait.Text(image["inlineData"]!["data"])!));
        await File.WriteAllTextAsync(Path.Combine(f.Work, "text.png"), "ordinary text\n");
        var text = await f.Call("read", new JsonObject { ["filePath"] = "text.png" });
        Assert.Null(text["inlineData"]);
        Assert.Contains("ordinary text", SessionWait.Text(text["output"]));
    }

    [Theory]
    [InlineData("89504e470d0a1a0a", "image/png")]
    [InlineData("ffd8ff", "image/jpeg")]
    [InlineData("524946460000000057454250", "image/webp")]
    [InlineData("474946380000", "image/gif")]
    [InlineData("424d", "image/bmp")]
    [InlineData("89504e47", null)]
    [InlineData("47494638", null)]
    [InlineData("74657874", null)]
    public void Classification_matches_bounded_Source_signatures_without_decoding(string hex, string? mime) =>
        Assert.Equal(mime, RasterImageMime.Detect(Convert.FromHexString(hex)));
}
