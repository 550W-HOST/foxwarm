using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Activity records carry argument previews outside the history masking point, so they are
    // masked here with the same instance secrets.
    internal string RedactActivity(string text, string? sessionId) =>
        Secrets?.Redact(text, "activity", sessionId) ?? text;

    /// <summary>
    /// A copy of tool arguments with every string value masked, so a preview built from it and
    /// then shortened cannot keep part of a secret.
    /// </summary>
    internal JsonObject RedactActivity(JsonObject args, string? sessionId) =>
        Secrets?.Redact(args.DeepClone(), "activity", sessionId) as JsonObject
        ?? (JsonObject)args.DeepClone();
}
