using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

// Attribution and cost of Images API requests: journal, usage ledger and usage overview name
// the image model and API that was called, and price it only with imageGeneration.pricing.
public sealed partial class ImagesApiImageGenerationTests
{
    private const string ImageModelKey = "p/gpt-image-2";

    private static JsonObject Prices(double input = 5, double imageInput = 8, double output = 30) =>
        new()
        {
            ["input"] = input,
            ["imageInput"] = imageInput,
            ["output"] = output,
        };

    // (40 text * 5 + 10 image * 8 + 4160 output * 30) / 1M for the standard fixture usage.
    private const double StandardCost = 0.12508;

    private static JsonObject PricedSettings(JsonObject? prices = null)
    {
        var settings = ImageSettings();
        settings["pricing"] = prices ?? Prices();
        return settings;
    }

    private static Func<Uri, HostModels> PricedCatalog(bool websocket) =>
        uri => Catalog(uri, websocket, PricedSettings());

    private static SqliteConnection OpenJournal(TurnRun run)
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(
                    run.Temp.Path,
                    "data",
                    "state",
                    "llm-request-journal.sqlite"
                ),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    private static object? Scalar(TurnRun run, string sql)
    {
        using var connection = OpenJournal(run);
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private static async Task<JsonObject> ImageRecordAsync(TurnRun run)
    {
        var journal = Assert.Single(
            await run.Manager.Journal.ListAsync(run.Owner.Id, "image-generation", null, null, 10)
        )!;
        Assert.Equal(
            "p/m",
            journal["requestedModelKey"]!.GetValue<string>()
        );
        return await run.Manager.Journal.ReconstructAsync(journal["requestId"]!.GetValue<string>());
    }

    private static void AssertImageAttribution(TurnRun run, JsonObject record, double? cost)
    {
        var start = Assert.Single(record["attempts"]!.AsArray())!["start"]!.AsObject();
        Assert.Equal(ImageModelKey, start["concreteModelId"]!.GetValue<string>());
        Assert.Equal("openai-images", start["providerType"]!.GetValue<string>());
        // The conversation model is the request's requested model; virtual_model_key means a
        // virtual route and stays unset.
        Assert.Null(start["virtualModelKey"]);

        var row = "WHERE purpose='image-generation'";
        Assert.Equal(1L, Scalar(run, "SELECT count(*) FROM llm_usage " + row));
        Assert.Equal(
            1L,
            Scalar(
                run,
                $"SELECT count(*) FROM llm_usage {row} AND model_key='{ImageModelKey}' AND provider_key='p' AND provider_type='openai-images' AND virtual_model_key IS NULL AND input_tokens=50 AND output_tokens=4160"
            )
        );
        var recorded = Scalar(run, $"SELECT cost FROM llm_usage {row}");
        if (cost is null)
            Assert.True(recorded is null or DBNull);
        else
            Assert.Equal(cost.Value, Convert.ToDouble(recorded), 9);
    }

    private static async Task AssertUsageViewAsync(TurnRun run, double? cost)
    {
        // The image model is not in the catalog; usage and its groupings only treat keys as text.
        Assert.False(Catalog(new Uri("http://localhost"), false).Contains(ImageModelKey));
        long[] period = [0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000];
        var models = await run.Manager.Usage.QueryAsync(period, "model", null, 100);
        var group = models["groups"]!
            .AsArray()
            .Select(item => item!.AsObject())
            .Single(item => item["key"]!.GetValue<string>() == ImageModelKey);
        Assert.Equal("model", group["kind"]!.GetValue<string>());
        Assert.Equal(1, group["usage"]!["requests"]!.GetValue<long>());
        if (cost is null)
            Assert.Null(group["usage"]!["cost"]);
        else
            Assert.Equal(cost.Value, group["usage"]!["cost"]!.GetValue<double>(), 9);
        var purposes = await run.Manager.Usage.QueryAsync(period, "purpose", null, 100);
        Assert.Equal(
            1,
            purposes["groups"]!
                .AsArray()
                .Single(item => item!["key"]!.GetValue<string>() == "image-generation")![
                "usage"
            ]!["requests"]!.GetValue<long>()
        );
        var sessions = await run.Manager.Usage.QueryAsync(period, "session", null, 100);
        Assert.True(sessions["groupCount"]!.GetValue<int>() >= 1);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Generation_is_attributed_to_the_image_model_and_priced(bool websocket)
    {
        await using var run = await RunTurnAsync(
            websocket,
            "{\"prompt\":\"Draw a blue circle\"}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString()),
            catalog: PricedCatalog(websocket)
        );
        Assert.Equal("/images/generations", Assert.Single(run.Images.Calls).Path);
        AssertImageAttribution(run, await ImageRecordAsync(run), StandardCost);
        // The conversation requests of the same turn keep the conversation model.
        Assert.Equal(
            0L,
            Scalar(
                run,
                "SELECT count(*) FROM llm_usage WHERE purpose='normal-turn' AND model_key<>'p/m'"
            )
        );
        await AssertUsageViewAsync(run, StandardCost);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Edit_is_attributed_to_the_image_model_and_priced(bool websocket)
    {
        await using var run = await RunTurnAsync(
            websocket,
            "{\"prompt\":\"Combine them\",\"imageIds\":[\"first-image\",\"second-image\"]}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString()),
            referenceImages: true,
            catalog: PricedCatalog(websocket)
        );
        Assert.Equal("/images/edits", Assert.Single(run.Images.Calls).Path);
        AssertImageAttribution(run, await ImageRecordAsync(run), StandardCost);
        await AssertUsageViewAsync(run, StandardCost);
    }

    [Fact]
    public async Task Without_pricing_the_request_is_attributed_and_has_no_cost()
    {
        await using var run = await RunTurnAsync(
            true,
            "{\"prompt\":\"Draw\"}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString())
        );
        var record = await ImageRecordAsync(run);
        AssertImageAttribution(run, record, null);
        // Neither the conversation model's pricing nor any image price applies.
        Assert.DoesNotContain("\"cost\"", record.ToJsonString());
        await AssertUsageViewAsync(run, null);
    }

    [Fact]
    public async Task Usage_that_does_not_fit_the_prices_stays_unpriced()
    {
        var result = ImageResult();
        result["usage"]!["input_tokens_details"]!["text_tokens"] = 41;
        await using var run = await RunTurnAsync(
            false,
            "{\"prompt\":\"Draw\"}",
            _ => (200, result),
            body => Assert.Contains("Generated one image.", body.ToJsonString()),
            catalog: PricedCatalog(false)
        );
        AssertImageAttribution(run, await ImageRecordAsync(run), null);
    }

    [Fact]
    public async Task A_rebuilt_ledger_keeps_the_image_attribution()
    {
        await using var run = await RunTurnAsync(
            true,
            "{\"prompt\":\"Draw\"}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString()),
            catalog: PricedCatalog(true)
        );
        var path = Path.Combine(run.Temp.Path, "data", "state", "llm-request-journal.sqlite");
        using (
            var writer = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
            )
        )
        {
            writer.Open();
            using var command = writer.CreateCommand();
            command.CommandText = "DELETE FROM llm_usage";
            command.ExecuteNonQuery();
        }
        await run.Manager.Journal.BackfillUsageAsync(CancellationToken.None);
        // The ledger is rebuilt from the attempt start, which names the image model; the
        // price is the result's recorded cost.
        Assert.Equal(
            1L,
            Scalar(
                run,
                $"SELECT count(*) FROM llm_usage WHERE purpose='image-generation' AND model_key='{ImageModelKey}' AND provider_key='p' AND provider_type='openai-images'"
            )
        );
        Assert.Equal(
            StandardCost,
            Convert.ToDouble(
                Scalar(run, "SELECT cost FROM llm_usage WHERE purpose='image-generation'")
            ),
            9
        );
    }

    [Fact]
    public void Attribution_names_the_image_model_only_for_images_api_image_requests()
    {
        var uri = new Uri("http://localhost");
        var images = Catalog(uri, true, PricedSettings()).Resolve("p/m");
        Assert.Equal(
            (ImageModelKey, "openai-images"),
            ImageGenerationRequests.Attribution(images, "image-generation")
        );
        Assert.Equal(
            ("p/m", "openai-ws"),
            ImageGenerationRequests.Attribution(images, "normal-turn")
        );
        // The Responses backend really calls the conversation model.
        var responses = Catalog(uri, true, ImageSettings(api: "responses")).Resolve("p/m");
        Assert.Equal(
            ("p/m", "openai-ws"),
            ImageGenerationRequests.Attribution(responses, "image-generation")
        );
    }

    [Fact]
    public void Image_cost_prices_text_and_reference_image_input_and_output()
    {
        var prices = Prices();
        JsonObject Usage(int input, int text, int image, int output) =>
            new()
            {
                ["input_tokens"] = input,
                ["output_tokens"] = output,
                ["input_tokens_details"] = new JsonObject
                {
                    ["text_tokens"] = text,
                    ["image_tokens"] = image,
                },
            };
        Assert.Equal(
            StandardCost,
            ModelUsageCost.ImageCost(Usage(50, 40, 10, 4160), prices, true)!.Value,
            9
        );
        Assert.Equal(
            (1_000_000 * 8d + 2_000_000 * 30d) / 1_000_000,
            ModelUsageCost.ImageCost(Usage(1_000_000, 0, 1_000_000, 2_000_000), prices, true)!.Value,
            9
        );
        // Without details, a generation's input is all text and an edit's is unknown.
        var bare = new JsonObject { ["input_tokens"] = 100, ["output_tokens"] = 1000 };
        Assert.Equal(0.0305, ModelUsageCost.ImageCost(bare, prices, false)!.Value, 9);
        Assert.Null(ModelUsageCost.ImageCost(bare, prices, true));
        // Counts that do not match the rates exactly are never guessed.
        Assert.Null(ModelUsageCost.ImageCost(Usage(50, 40, 11, 10), prices, true));
        Assert.Null(ModelUsageCost.ImageCost(null, prices, false));
        var cached = Usage(50, 40, 10, 10);
        cached["input_tokens_details"]!["cached_tokens"] = 4;
        Assert.Null(ModelUsageCost.ImageCost(cached, prices, false));
        var noOutput = Usage(50, 40, 10, 10);
        noOutput.Remove("output_tokens");
        Assert.Null(ModelUsageCost.ImageCost(noOutput, prices, false));
        var fractional = Usage(50, 40, 10, 10);
        fractional["output_tokens"] = 1.5;
        Assert.Null(ModelUsageCost.ImageCost(fractional, prices, false));
        Assert.Equal(0, ModelUsageCost.ImageCost(Usage(0, 0, 0, 0), prices, true)!.Value);
    }

    [Fact]
    public void Service_priced_usage_keeps_its_cost_and_other_usage_is_repriced()
    {
        var leaf = Catalog(new Uri("http://localhost"), false).Resolve("p/m");
        var usage = new JsonObject
        {
            ["inputTokens"] = 1_000_000,
            ["cachedTokens"] = 0,
            ["outputTokens"] = 0,
            ["cost"] = 99d,
        };
        Assert.Equal(
            99d,
            ModelUsageCost
                .Complete(leaf, new ChatResult(null, usage) { UsagePricedByService = true })!["cost"]!
                .GetValue<double>()
        );
        // Conversation usage never trusts a cost it did not compute: it takes the model's rate.
        Assert.Equal(
            2d,
            ModelUsageCost.Complete(leaf, new ChatResult(null, usage))!["cost"]!.GetValue<double>()
        );
        var unpriced = new JsonObject { ["inputTokens"] = 5, ["cachedTokens"] = 0, ["outputTokens"] = 1 };
        Assert.Null(
            ModelUsageCost
                .Complete(leaf, new ChatResult(null, unpriced) { UsagePricedByService = true })!["cost"]
        );
    }

    [Fact]
    public void Pricing_is_validated_and_inherited_with_the_image_settings()
    {
        var uri = new Uri("http://localhost");
        InvalidDataException Fails(JsonObject provider, JsonNode? model = null) =>
            Assert.Throws<InvalidDataException>(() =>
                Catalog(uri, false, provider, model).Resolve("p/m")
            );
        JsonObject With(Action<JsonObject> change)
        {
            var settings = PricedSettings();
            change(settings);
            return settings;
        }
        Assert.Contains(
            "imageGeneration.pricing.imageInput",
            Fails(With(s => s["pricing"] = new JsonObject { ["input"] = 5, ["output"] = 30 })).Message
        );
        Assert.Contains(
            "imageGeneration.pricing.input",
            Fails(With(s => s["pricing"]!["input"] = -1)).Message
        );
        Assert.Contains(
            "only accepts",
            Fails(With(s => s["pricing"]!["cached"] = 1)).Message
        );
        Assert.Contains(
            "imageGeneration.pricing",
            Fails(With(s => s["pricing"] = JsonValue.Create(3))).Message
        );
        // Prices only apply to the Images API call, so they cannot sit on another backend.
        Assert.Contains(
            "requires imageGeneration.api images",
            Fails(With(s => s["api"] = "responses")).Message
        );
        Assert.Contains(
            "requires imageGeneration.api images",
            Fails(PricedSettings(), new JsonObject { ["api"] = "responses" }).Message
        );

        var inherited = Catalog(uri, false, PricedSettings(), JsonValue.Create(true))
            .Resolve("p/m");
        Assert.Equal(
            5,
            inherited.Configuration["imageGeneration"]!["pricing"]!["input"]!.GetValue<double>()
        );
        // A model's pricing replaces the provider's as a whole.
        var overridden = Catalog(
                uri,
                false,
                PricedSettings(),
                new JsonObject { ["pricing"] = Prices(1, 2, 3) }
            )
            .Resolve("p/m");
        var pricing = overridden.Configuration["imageGeneration"]!["pricing"]!;
        Assert.Equal(
            [1d, 2d, 3d],
            new[] { "input", "imageInput", "output" }.Select(key => pricing[key]!.GetValue<double>())
        );
        // Without pricing the effective configuration carries none.
        Assert.Null(
            Catalog(uri, false, ImageSettings()).Resolve("p/m").Configuration["imageGeneration"]![
                "pricing"
            ]
        );
    }

    [Fact]
    public void Editing_image_prices_does_not_change_the_routing_fingerprint()
    {
        var uri = new Uri("http://localhost");
        string Fingerprint(JsonObject settings) =>
            ModelRoutingFingerprint.Build(
                "failover",
                ["p/m"],
                [Catalog(uri, false, settings).Resolve("p/m")],
                1,
                1000
            );
        var baseline = Fingerprint(PricedSettings());
        Assert.Equal(baseline, Fingerprint(PricedSettings(Prices(6, 9, 31))));
        Assert.Equal(baseline, Fingerprint(ImageSettings()));
        var other = PricedSettings();
        other["quality"] = "low";
        Assert.NotEqual(baseline, Fingerprint(other));
    }
}
