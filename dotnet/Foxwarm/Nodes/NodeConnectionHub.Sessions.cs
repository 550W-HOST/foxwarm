using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed partial class NodeConnectionHub
{
    internal Func<string, JsonObject, Action, CancellationToken, Task<JsonObject>>? SessionRequest
    {
        get;
        set;
    }

    private async Task HandleSessionRequestAsync(
        Connection connection,
        JsonObject message,
        CancellationToken token
    )
    {
        void RequireCurrentConnection()
        {
            token.ThrowIfCancellationRequested();
            lock (gate)
            {
                if (connection.Retired || !connection.Open || !nodes.TryGetValue(connection.Id!, out var active) || !ReferenceEquals(active, connection))
                    throw new IOException("Node connection replaced.");
            }
        }

        var response = new JsonObject
        {
            ["type"] = "cli_response",
            ["requestId"] = SessionRequestString(message["requestId"]),
        };
        try
        {
            RequireCurrentConnection();
            response["result"] = await (
                SessionRequest
                ?? throw new InvalidOperationException("Node Session requests are unavailable.")
            )(connection.Id!, message, RequireCurrentConnection, token);
            response["ok"] = true;
        }
        catch (Exception error)
            when (error is InvalidOperationException or IOException or InvalidDataException)
        {
            response["ok"] = false;
            response["error"] = error.Message;
        }
        await SendAsync(connection, response, token, RequireCurrentConnection);
    }

    // These fields follow Source's String(value || '') wire coercion.
    internal static string SessionRequestString(JsonNode? value) =>
        SessionRequestTruthy(value) ? SessionRequestValueString(value) : "";

    internal static string SessionRequestValueString(JsonNode? value) =>
        value switch
        {
            null => "",
            JsonObject => "[object Object]",
            JsonArray array => string.Join(",", array.Select(SessionRequestValueString)),
            _ => SessionWait.Text(value) ?? EcmaJson.Stringify(value),
        };

    internal static bool SessionRequestTruthy(JsonNode? value) =>
        value is not null
        && (
            value is JsonObject or JsonArray
            || SessionWait.Text(value) is { Length: > 0 }
            || value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag) && flag
            || SessionWait.Number(value) is { } number && number != 0
        );
}
