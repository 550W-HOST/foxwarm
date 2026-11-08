using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Secrets;

// Stage S of model-request preparation: irreversible masking of known values in the
// instructions, tool definitions and history copy, before the journal manifest, any
// reversible text-redaction stage and provider serialization. It never fails a request.
internal static class SecretRequestStage
{
    internal sealed record Result(string Instructions, JsonArray? Tools, RequestHistory History);

    internal static Result Apply(
        InstanceSecrets secrets,
        string instructions,
        JsonArray? tools,
        RequestHistory history,
        string? sessionId
    )
    {
        var redactor = secrets.Redactor;
        if (redactor.IsEmpty)
            return new(instructions, tools, history);
        var findings = new SecretMessageRedaction.Findings();
        var maskedInstructions = redactor.Redact(instructions, findings.Masked);
        var maskedTools = tools is null ? null : (JsonArray?)redactor.Redact(tools, findings.Masked);
        RequestHistory.Row[]? rows = null;
        for (var index = 0; index < history.Rows.Count; index++)
        {
            var row = history.Rows[index];
            var masked = SecretMessageRedaction.Message(redactor, row.Message, findings);
            if (ReferenceEquals(masked, row.Message))
                continue;
            rows ??= history.Rows.ToArray();
            // A changed row no longer has the stored record's content or identity.
            rows[index] = new RequestHistory.Row(masked);
        }
        secrets.Record(findings, "model-request", sessionId);
        return new(
            maskedInstructions,
            maskedTools,
            rows is null ? history : new RequestHistory(rows)
        );
    }

    // Text sent to other model-facing services (embeddings, external runtimes).
    internal static string Text(InstanceSecrets? secrets, string text, string source, string? sessionId) =>
        secrets is null ? text : secrets.Redact(text, source, sessionId);
}
