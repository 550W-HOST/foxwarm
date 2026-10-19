using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class ProviderFileConsumerTests
{
    [Fact]
    public async Task Primitive_reader_uses_bounded_header_and_native_ToolScript_promotes_normalized_image_parts()
    {
        if (!OperatingSystem.IsLinux()) return;
        await using var f = await Fixture.Create();
        Success(await f.Manager.SelectNodeAsync(f.Owner, f.Node));
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        await f.Seed("image.dat", bytes);
        await f.Seed("text.png", Encoding.UTF8.GetBytes("not an image\n"));
        await f.Seed("bitmap.bin", "BM"u8.ToArray());
        var image = await f.Call("read", Args("image.dat"));
        Success(image);
        Assert.Equal("image/png", SessionWait.Text(image["inlineData"]!["mimeType"]));
        Assert.Equal(bytes, Convert.FromBase64String(SessionWait.Text(image["inlineData"]!["data"])!));
        var text = await f.Call("read", Args("text.png"));
        Success(text);
        Assert.Null(text["inlineData"]);
        Assert.Contains("not an image", SessionWait.Text(text["output"]));
        var bmp = await f.Call("read", Args("bitmap.bin"));
        Assert.Equal("image/bmp", SessionWait.Text(bmp["inlineData"]!["mimeType"]));
        var requests = await f.Requests();
        Assert.Contains(requests, request => request["operation"]?.ToString() == "filesystem"
            && request["request"]?["operation"]?.ToString() == "read"
            && request["request"]?["count"]?.ToString() == "12");
        var completed = await f.Call("run_script", new JsonObject { ["code"] = "result=call_tool('read', {'filePath':'image.dat'})\nresult['business']={'retained':True}\nreturn result" });
        Assert.Equal("completed", SessionWait.Text(completed["status"]));
        Assert.True(completed["result"]!["business"]!["retained"]!.GetValue<bool>());
        Assert.NotNull(completed["imageParts"]);
        var message = new JsonObject { ["role"] = "tool", ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = new JsonObject { ["tool_use_id"] = "provider-image", ["response"] = completed.DeepClone() } }) };
        await f.Manager.Images.ExternalizeMessageAsync(message);
        Assert.Equal(bytes, await f.Manager.Images.ReadAsync(message["parts"]![1]!["inlineDataRef"]!.AsObject()));
    }
}
