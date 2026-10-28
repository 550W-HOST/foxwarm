using System.Text.Json;

namespace Foxwarm.Sessions;

// Only first-party validators attach this detail. Ordinary exception text, including
// filesystem paths, configuration values and provider bodies, is never promoted to it.
internal sealed record SessionAuthorityDiagnostic(string? Field, string Reason)
{
    internal string Format(string? sessionId = null)
    {
        var context = sessionId is null ? "" :
            $"session={JsonSerializer.Serialize(sessionId)} file={JsonSerializer.Serialize("state/sessions/" + sessionId + ".json")} ";
        return context + (Field is null ? "" : $"field={JsonSerializer.Serialize(Field)} ")
            + "reason=" + JsonSerializer.Serialize(Reason);
    }
}

internal static class SessionAuthorityErrors
{
    private static readonly object DiagnosticKey = new();

    internal static InvalidDataException Invalid(string reason, string? field = null) =>
        Mark(new InvalidDataException(reason), reason, field);

    internal static UnsupportedSessionAuthorityException Unsupported(string reason, string? field = null) =>
        Mark(new UnsupportedSessionAuthorityException(reason), reason, field);

    private static T Mark<T>(T error, string reason, string? field) where T : Exception
    {
        error.Data[DiagnosticKey] = new SessionAuthorityDiagnostic(field, reason);
        return error;
    }

    internal static SessionAuthorityDiagnostic? Detail(Exception error) =>
        error.Data[DiagnosticKey] as SessionAuthorityDiagnostic;

    internal static SessionAuthorityUnavailableException Unavailable(string id, Exception error) =>
        new(id, Detail(error) ?? new(null, error switch
        {
            FileNotFoundException or DirectoryNotFoundException => "Session authority file is missing.",
            UnauthorizedAccessException => "Session authority file is not readable.",
            System.Text.Json.JsonException => "Session authority is not valid JSON.",
            IOException => "Session authority file could not be read.",
            _ => "Session authority has an invalid value shape.",
        }), error);
}

// This exception denotes only pre-activation local ingress failure. It must never
// wrap Catalog/Archive access, image publication, strict-save or committed failures.
internal sealed class SessionAuthorityUnavailableException(
    string sessionId,
    SessionAuthorityDiagnostic diagnostic,
    Exception? cause = null
) : IOException(diagnostic.Format(sessionId), cause)
{
    internal string SessionId { get; } = sessionId;
    internal SessionAuthorityDiagnostic Diagnostic { get; } = diagnostic;
}

internal sealed class SessionAuthorityIdentityException(string sessionId)
    : IOException(new SessionAuthorityDiagnostic("id", "Authority identity does not match its catalog ID.").Format(sessionId))
{
    internal string SafeDetail => Message;
}
