using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Shared read-only ingress for semantic admission, catalog migration and upgrade inspection.
// Image externalization and owner recovery belong to the caller after this succeeds.
internal static class SessionAuthorityReader
{
    internal static JsonObject Read(
        string root,
        string id,
        string agent,
        JsonObject? legacyCatalog = null,
        JsonObject? main = null
    )
    {
        return Normalize(ReadRaw(root, id), id, agent, legacyCatalog, main);
    }

    internal static JsonObject ReadRaw(string root, string id)
    {
        var path = new LinuxAtomicJsonFile(root, $"state/sessions/{id}.json").FilePath;
        try
        {
            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject
                ?? throw SessionAuthorityErrors.Invalid("Session authority must be a JSON object.");
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidDataException
                        or UnauthorizedAccessException
                        or JsonException
            )
        {
            throw SessionAuthorityErrors.Unavailable(id, error);
        }
    }

    internal static JsonObject Normalize(
        JsonObject raw,
        string id,
        string agent,
        JsonObject? legacyCatalog = null,
        JsonObject? main = null
    )
    {
        try
        {
            var value = SessionCatalog.NormalizeAuthority(raw, id, agent, legacyCatalog);
            if (main is not null)
                SessionCatalog.OverlayAuthorityContext(value, main);
            SessionAuthorityDocument.Validate(value, id, agent);
            try
            {
                SessionManager.ValidateExecutionEnvironment(value, "", "");
            }
            catch (InvalidDataException)
            {
                throw SessionAuthorityErrors.Invalid(
                    "Session Node identity is invalid.",
                    "currentNode"
                );
            }
            if (
                value["stopping"] is JsonValue stopping
                && stopping.TryGetValue<bool>(out var stopped)
                && stopped
                && value["busy"]!.GetValue<bool>() == false
            )
                throw SessionAuthorityErrors.Invalid(
                    "Stopping-only Session cannot be resumed automatically by the Session host.",
                    "stopping"
                );
            return value;
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or UnsupportedSessionAuthorityException
                        or InvalidOperationException
                        or FormatException
                        or OverflowException
                        or ArgumentException
            )
        {
            throw SessionAuthorityErrors.Unavailable(id, error);
        }
    }
}
