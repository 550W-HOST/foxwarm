namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Direct activity records carry argument previews outside the history masking point, so
    // they are masked here with the same instance secrets.
    internal string RedactActivity(string text, string? sessionId) =>
        Secrets?.Redact(text, "activity", sessionId) ?? text;
}
