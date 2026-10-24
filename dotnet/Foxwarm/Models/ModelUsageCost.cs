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
                "tokenPricesPerMillion must be a complete cached/input/output object."
            );
        foreach (var key in new[] { "cached", "input", "output" })
            if (Nonnegative(prices[key]) is null)
                throw new InvalidDataException(
                    "tokenPricesPerMillion." + key + " must be a finite nonnegative number."
                );
        if (prices.Any(pair => pair.Key is not ("cached" or "input" or "output")))
            throw new InvalidDataException(
                "tokenPricesPerMillion only accepts cached, input and output."
            );
        return (JsonObject)prices.DeepClone();
    }

    internal static JsonObject? Complete(ConcreteHostModel model, ChatResult result)
    {
        var source = result.Usage ?? result.AssistantMessage?["__meta"]?["usage"] as JsonObject;
        if (source is null)
            return null;
        var usage = (JsonObject)source.DeepClone();
        usage.Remove("cost");
        if (model.Configuration["tokenPricesPerMillion"] is not JsonObject prices)
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
