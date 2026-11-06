using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class RequestSizeDiagnostics
{
    internal static bool IsSizeFailure(ModelAttemptFailure failure) =>
        failure.Status == "413"
        || Regex.IsMatch(
            failure.Message,
            @"context[_ -](length|window|limit)|maximum context|too many tokens|token limit|(?:prompt|request|input|payload|message).{0,40}(?:too (?:large|long)|exceed)|(?:too (?:large|long)).{0,40}(?:prompt|request|input)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
        );

    internal static string Breakdown(
        string instructions,
        string baseInstructions,
        JsonArray? tools,
        RequestHistory history
    )
    {
        // Session callers compose the unchanged base followed by the saved memory snapshot.
        // Low-level callers without that composition have only base instructions.
        var memory = "";
        if (instructions.StartsWith(baseInstructions, StringComparison.Ordinal))
        {
            var suffix = instructions[baseInstructions.Length..];
            if (baseInstructions.Length > 0 && suffix.StartsWith("\n\n", StringComparison.Ordinal))
                suffix = suffix[2..];
            if (ConditionalMemory.ReadCurrentModelSnapshotId(suffix) is not null)
                memory = suffix;
        }
        var baseTokens = CompactCandidateBuilder.Tokens(
            memory.Length == 0 ? instructions : baseInstructions
        );
        var memoryTokens = CompactCandidateBuilder.Tokens(memory);
        var toolTokens = tools is { Count: > 0 }
            ? CompactCandidateBuilder.Tokens(tools.ToJsonString())
            : 0;
        var remainder = RequestHistoryRepair
            .SelectAndRepair(history)
            .Messages.Sum(message => Foxwarm.Images.ImageTokenEstimate.Message(message).Tokens);
        return $"Estimated request tokens: base instructions {baseTokens}; memory snapshot {memoryTokens}; tool declarations {toolTokens}; history/request remainder {remainder}; total {baseTokens + memoryTokens + toolTokens + remainder}.";
    }
}
