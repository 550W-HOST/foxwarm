using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ModelDefaultsTests
{
    private static JsonObject Obj(string text) => JsonNode.Parse(text)!.AsObject();

    [Fact]
    public void Concrete_defaults_resolve_every_layer_and_virtuals_use_the_minimum_leaf_window()
    {
        var root = Obj("""
            {"defaults":{"contextLimit":3000,"maxOutput":300,"providerImageOutputFormat":"jpeg"},"providers":{
              "a":{"providerType":"openai-responses","contextLimit":2000,"maxOutput":200,"providerImageOutputFormat":"webp","models":[{"id":"m","contextLimit":1000,"maxOutput":100,"providerImageOutputFormat":"jpeg"},"n"]},
              "b":{"provider":"openai-completions","models":["m"]},"pool":{"providerType":"session-hash","targets":["a/m","b"]}}}
            """);
        var app = Obj("""{"llm":{"contextLimit":4000,"maxOutput":400,"providerImageOutputFormat":"webp"}}""");
        void Check(string key, int context, int output, string image)
        {
            var leaf = HostModels.Parse(root, app).Resolve(key);
            Assert.Equal(context, leaf.ContextLimit);
            Assert.Equal(output, leaf.MaxOutput);
            Assert.Equal(image, leaf.ProviderImageOutputFormat);
        }
        Check("a/m", 1000, 100, "jpeg");
        Check("a/n", 2000, 200, "webp");
        Check("b", 3000, 300, "jpeg");
        Assert.Equal(1000, HostModels.Parse(root, app).Resolve("pool").ContextLimit);
        root.Remove("defaults");
        Check("b", 4000, 400, "webp");
        app.Clear();
        Check("b", 200000, 32768, "webp");
    }

    [Fact]
    public void Positive_model_settings_retain_Source_number_values_above_Int32_without_flooring_or_fallback()
    {
        var root = Obj("""{"defaults":{"contextLimit":3000000000,"maxOutput":3000000001},"providers":{"a":{"models":["m"]}}}""");
        var leaf = HostModels.Parse(root, new JsonObject()).Resolve("a");
        Assert.Equal(3000000000d, leaf.ContextLimit);
        Assert.Equal(3000000001d, leaf.MaxOutput);
        var options = ConfiguredModelRequests.Plan(leaf, new(new Uri("http://localhost"), "m", "a/m", "", "", 10), "high", "", "cache", "turn");
        Assert.Equal(3000000001d, ResponsesRequestPlan.Build([], options)["max_output_tokens"]!.GetValue<double>());
        root["defaults"]!["maxOutput"] = 3000000000.5d;
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
    }

    [Fact]
    public async Task Invalid_masked_settings_never_replace_installed_bytes_or_catalog()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "state/config.yaml"), "llm:\n  contextLimit: 4000\n  maxOutput: 400\n");
        var config = new ModelConfiguration(temp.Path);
        var root = Obj("""
            {"defaults":{"contextLimit":3000,"maxOutput":300,"providerImageOutputFormat":"jpeg"},"providers":{"a":{"contextLimit":2000,"maxOutput":200,"providerImageOutputFormat":"webp","models":[{"id":"m","contextLimit":1000,"maxOutput":100,"providerImageOutputFormat":"jpeg"}]}}}
            """);
        var bytes = Encoding.UTF8.GetBytes(root.ToJsonString());
        await config.InstallAsync("models", _ => Task.FromResult(bytes));
        foreach (var scope in new[] { "defaults", "provider", "model" })
        foreach (var (field, invalid) in new (string, JsonNode?)[]
        {
            ("contextLimit", null), ("contextLimit", JsonValue.Create(1.5)),
            ("maxOutput", JsonValue.Create("100")), ("maxOutput", JsonValue.Create(0)),
            ("providerImageOutputFormat", JsonValue.Create("png")),
        })
        {
            var bad = (JsonObject)root.DeepClone();
            var target = scope == "defaults" ? bad["defaults"]!.AsObject()
                : scope == "provider" ? bad["providers"]!["a"]!.AsObject()
                : bad["providers"]!["a"]!["models"]![0]!.AsObject();
            target[field] = invalid?.DeepClone();
            await Assert.ThrowsAsync<InvalidDataException>(() => config.InstallAsync("models", _ => Task.FromResult(Encoding.UTF8.GetBytes(bad.ToJsonString()))));
            Assert.Equal(bytes, await File.ReadAllBytesAsync(config.ActivePath));
            Assert.Equal(100, config.Capture().Resolve("a").MaxOutput);
        }
        var installedApp = await File.ReadAllTextAsync(config.AppPath);
        foreach (var field in new[] { "contextLimit", "maxOutput", "providerImageOutputFormat" })
        {
            var badApp = Obj("""{"llm":{"contextLimit":4000,"maxOutput":400,"providerImageOutputFormat":"webp"}}""");
            badApp["llm"]![field] = null;
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, badApp));
            Assert.Throws<InvalidDataException>(() => AppConfigurationRules.Validate(badApp));
            await Assert.ThrowsAsync<InvalidDataException>(() => config.InstallAsync("config", _ => Task.FromResult(Encoding.UTF8.GetBytes(badApp.ToJsonString()))));
            Assert.Equal(installedApp, await File.ReadAllTextAsync(config.AppPath));
        }
        root["defaults"]!["extraFields"] = new JsonObject();
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
        root["defaults"]!.AsObject().Remove("extraFields");
        root["providers"]!["a"]!["providerType"] = "unknown";
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
    }

    [Fact]
    public void Provider_aliases_and_empty_type_fallback_survive_while_unknown_truthy_types_are_rejected()
    {
        var root = Obj("""{"providers":{"a":{"providerType":"","provider":"openai","models":["m"]},"b":{"provider":"anthropic","models":["m"]},"pool":{"provider":"failover","targets":["a","b"]}}}""");
        Assert.True(HostModels.Parse(root, new JsonObject()).Resolve("pool").IsVirtual);
        foreach (var type in new[] { "openai", "openai-responses", "openai-ws", "openai-completions", "anthropic" })
        {
            root["providers"]!["a"]!["providerType"] = type;
            Assert.Equal(type, HostModels.Parse(root, new JsonObject()).Resolve("a").ProviderType);
        }
        foreach (var type in new JsonNode[] { JsonValue.Create("unknown"), JsonValue.Create(true), JsonValue.Create(123), new JsonObject() })
        {
            root["providers"]!["a"]!["providerType"] = type;
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
        }
    }

    [Fact]
    public void Virtuals_forbid_concrete_defaults_and_effective_changes_invalidate_routing_fingerprints()
    {
        var root = Obj("""{"providers":{"a":{"models":["m"]},"b":{"models":["m"]},"pool":{"providerType":"failover","targets":["a","b"]}}}""");
        var original = HostModels.Parse(root, new JsonObject()).Resolve("pool").Configuration["fingerprint"]!.ToString();
        foreach (var (field, value) in new (string, JsonNode)[] { ("maxOutput", JsonValue.Create(123)), ("providerImageOutputFormat", JsonValue.Create("jpeg")) })
        {
            var changed = (JsonObject)root.DeepClone();
            changed["defaults"] = new JsonObject { [field] = value.DeepClone() };
            Assert.NotEqual(original, HostModels.Parse(changed, new JsonObject()).Resolve("pool").Configuration["fingerprint"]!.ToString());
            changed["providers"]!["pool"]![field] = value.DeepClone();
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(changed, new JsonObject()));
        }
        var leaf = HostModels.Parse(root, new JsonObject()).Resolve("a") with { ProviderType = "unknown" };
        using var http = new HttpClient();
        Assert.Throws<InvalidDataException>(() => ConfiguredModelRequests.CreatePreparedService(http, leaf, new(new Uri("http://localhost"), "m", "a/m", "", "", 10), "cache"));
    }

    [Theory]
    [InlineData("a", "webp", 111)]
    [InlineData("b", "jpeg", 222)]
    public async Task Physical_virtual_leaf_requests_use_leaf_output_and_input_image_settings(string selected, string format, int output)
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var image = await blobs.PutAsync(ImageCodecTests.Raster(SKEncodedImageFormat.Png, 4097, 2), "image/png", "input");
        var catalog = HostModels.Parse(Obj("""
            {"providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","maxOutput":111,"providerImageOutputFormat":"webp","models":["m"]},"b":{"providerType":"openai-responses","baseUrl":"http://localhost/b","maxOutput":222,"providerImageOutputFormat":"jpeg","models":["m"]},"pool":{"providerType":"session-hash","targets":["a","b"]}}}
            """), new JsonObject());
        var cache = Enumerable.Range(0, 100).Select(i => "cache" + i).First(key => ModelRouting.Hash("pool", key, ["a/m", "b/m"]).TargetKey == selected + "/m");
        using var http = new HttpClient(new Handler(async request =>
        {
            Assert.Equal("/" + selected + "/responses", request.RequestUri!.AbsolutePath);
            var body = Obj(await request.Content!.ReadAsStringAsync());
            Assert.Equal(output, body["max_output_tokens"]!.GetValue<int>());
            var wireImage = Assert.Single(body["input"]!.AsArray().OfType<JsonObject>().SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? []), part => SessionWait.Text(part["type"]) == "input_image")["image_url"]!.ToString();
            Assert.StartsWith("data:image/" + format + ";base64,", wireImage);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n", Encoding.UTF8, "text/event-stream") };
        }));
        var owner = new ModelRequestOwner(http, new(new Uri("http://localhost"), "m", "a/m", "", "", 999), new ModelRouting(), (_, _) => Task.CompletedTask, images: blobs);
        var result = await owner.RequestAsync("s", catalog, "pool", null, cache, "turn", [new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = image }) }], (_, _) => Task.FromResult("prompt"), null, null, null, null, CancellationToken.None);
        Assert.Equal("done", result.AssistantMessage!["parts"]![0]!["text"]!.ToString());
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request);
    }
}
