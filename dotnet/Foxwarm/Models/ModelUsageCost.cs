using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

/// <summary>USD estimates from the captured concrete model and normalized, nonoverlapping tokens.</summary>
internal static class ModelUsageCost
{
    internal static JsonObject ValidatePrices(JsonNode? node)
    {
        if (node is not JsonObject prices)
            throw new InvalidDataException(
                "pricing must be a complete cached/input/output object."
            );
        foreach (var key in new[] { "cached", "input", "output" })
            if (Nonnegative(prices[key]) is null)
                throw new InvalidDataException(
                    "pricing." + key + " must be a finite nonnegative number."
                );
        if (prices.Any(pair => pair.Key is not ("cached" or "input" or "output")))
            throw new InvalidDataException("pricing only accepts cached, input and output.");
        return (JsonObject)prices.DeepClone();
    }

    // imageGeneration.pricing: text input, reference-image input and output rates of the image
    // model. There is no cached rate: the Images API reports no cached count.
    internal static JsonObject ValidateImagePrices(JsonNode? node)
    {
        if (node is not JsonObject prices)
            throw new InvalidDataException(
                "imageGeneration.pricing must be an input/imageInput/output object."
            );
        foreach (var key in ImageRates)
            if (Nonnegative(prices[key]) is null)
                throw new InvalidDataException(
                    "imageGeneration.pricing." + key + " must be a finite nonnegative number."
                );
        if (prices.Any(pair => !ImageRates.Contains(pair.Key)))
            throw new InvalidDataException(
                "imageGeneration.pricing only accepts input, imageInput and output."
            );
        return (JsonObject)prices.DeepClone();
    }

    private static readonly string[] ImageRates = ["input", "imageInput", "output"];

    /// <summary>
    /// USD for one Images API response from its reported usage, or null when the counts cannot
    /// be matched to the three rates exactly: missing or inconsistent counts, or cached tokens.
    /// Without input details, input counts as text for a generation and is unpriced for an edit.
    /// </summary>
    internal static double? ImageCost(JsonObject? usage, JsonObject prices, bool edit)
    {
        if (usage is null)
            return null;
        if (Count(usage["input_tokens"]) is not double input)
            return null;
        if (Count(usage["output_tokens"]) is not double output)
            return null;
        double text;
        double image;
        if (usage["input_tokens_details"] is JsonObject details)
        {
            if (details["cached_tokens"] is not null && Count(details["cached_tokens"]) != 0)
                return null;
            var reportedText = details["text_tokens"];
            var reportedImage = details["image_tokens"];
            if (reportedText is null && reportedImage is null)
                return null;
            text = reportedText is null ? 0 : Count(reportedText) ?? double.NaN;
            image = reportedImage is null ? 0 : Count(reportedImage) ?? double.NaN;
            if (double.IsNaN(text) || double.IsNaN(image) || text + image != input)
                return null;
        }
        else if (edit && input > 0)
            return null;
        else
        {
            text = input;
            image = 0;
        }
        if (
            Nonnegative(prices["input"]) is not double textRate
            || Nonnegative(prices["imageInput"]) is not double imageRate
            || Nonnegative(prices["output"]) is not double outputRate
        )
            return null;
        var cost = (text * textRate + image * imageRate + output * outputRate) / 1_000_000;
        return double.IsFinite(cost) ? cost : null;
    }

    private static double? Count(JsonNode? node) =>
        Nonnegative(node) is double number && number == Math.Floor(number) ? number : null;

    internal static JsonObject? Complete(ConcreteHostModel model, ChatResult result)
    {
        var source = result.Usage ?? result.AssistantMessage?["__meta"]?["usage"] as JsonObject;
        if (source is null)
            return null;
        var usage = (JsonObject)source.DeepClone();
        if (result.UsagePricedByService)
            return usage;
        usage.Remove("cost");
        if (model.Configuration["pricing"] is not JsonObject prices)
            return usage;
        var cost = 0d;
        foreach (
            var (tokens, rate) in new[]
            {
                ("cachedTokens", "cached"),
                ("inputTokens", "input"),
                ("outputTokens", "output"),
            }
        )
        {
            if (Nonnegative(usage[tokens]) is not double count)
                return usage;
            cost += count / 1_000_000 * SessionWait.Number(prices[rate])!.Value;
        }
        if (double.IsFinite(cost))
            usage["cost"] = cost;
        return usage;
    }

    internal static string FormatUsd(double amount) =>
        amount is > 0 and < .0001
            ? "< $0.0001 USD"
            : "$"
                + amount.ToString("#,##0.00##", System.Globalization.CultureInfo.InvariantCulture)
                + " USD";

    private static double? Nonnegative(JsonNode? node) =>
        SessionWait.Number(node) is double number && double.IsFinite(number) && number >= 0
            ? number
            : null;
}
