using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Reads a failed tool result in either shape: {error: "<message>", code?} or the legacy
// {error: {type, message}}.
internal static class ToolFailureTestExtensions
{
    internal static string? FailureMessage(this JsonNode? result) => ToolFailure.Message(result);

    internal static string? FailureCode(this JsonNode? result) => ToolFailure.Code(result);

    // A failure's code when it has one, else its message; null for a successful result.
    internal static string? FailureIdentity(this JsonNode? result) =>
        result.FailureCode() ?? result.FailureMessage();

    internal static JsonNode? FailureMessageNode(this JsonNode? result) =>
        result.FailureMessage() is { } message ? JsonValue.Create(message) : null;

    internal static JsonNode? FailureCodeNode(this JsonNode? result) =>
        result.FailureCode() is { } code ? JsonValue.Create(code) : null;
}
