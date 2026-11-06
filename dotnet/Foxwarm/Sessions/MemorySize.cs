using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed record MemorySize(
    int Bytes,
    int EstimatedTokens,
    double? ContextFraction,
    double ThresholdFraction
)
{
    internal bool OverThreshold => ContextFraction > ThresholdFraction;

    internal static MemorySize Measure(string snapshot, HostModels? models)
    {
        var modelId = ConditionalMemory.ReadCurrentModelSnapshotId(snapshot);
        var limit =
            modelId is not null && models?.Contains(modelId) == true
                ? models.Resolve(modelId).ContextLimit
                : (double?)null;
        var tokens = CompactCandidateBuilder.Tokens(snapshot);
        return new(
            Encoding.UTF8.GetByteCount(snapshot),
            tokens,
            limit is > 0 && double.IsFinite(limit.Value) ? tokens / limit.Value : null,
            models?.MemoryWarningThresholdFraction ?? .15
        );
    }

    internal static string Percent(double fraction) =>
        (fraction * 100).ToString("0.##", CultureInfo.InvariantCulture);

    internal string Notice() =>
        $"Memory notice: the injected memory for this Agent is about {EstimatedTokens} tokens ({Percent(ContextFraction!.Value)}% of the context window), above the {Percent(ThresholdFraction)}% limit. Consolidate it: keep top-level memory files to lasting rules and move reference material into memory subdirectories or docs.";

    internal JsonObject ToJson() =>
        new()
        {
            ["bytes"] = Bytes,
            ["estimatedTokens"] = EstimatedTokens,
            ["contextFraction"] = ContextFraction,
            ["thresholdFraction"] = ThresholdFraction,
            ["overThreshold"] = OverThreshold,
        };
}
