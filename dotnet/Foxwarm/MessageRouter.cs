using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record ChannelContext(string SessionId, string Platform);

internal sealed record ChannelMessage(
    string Text,
    string? ClientMessageId,
    IReadOnlyList<JsonObject>? Parts = null,
    string? ControlRequestId = null,
    // Who sent WebUI input: the administrator or a scoped identity. Administrator-only evidence.
    JsonObject? Sender = null
);

internal sealed record MessageRouteResult(int Status, object Value);

/// <summary>Supported Main-local ingress. Channels validate their wire DTO, this owner handles commands and admission.</summary>
internal sealed partial class MessageRouter(SessionRuntime runtime)
{
    public async Task<MessageRouteResult> HandleMessageAsync(
        ChannelContext context,
        ChannelMessage message,
        SessionOwner? attachmentOwner = null,
        Action? beforeAdmission = null
    )
    {
        if (TryReadCommand(message.Text, out var commandName, out var rawArgs))
            return await HandleWebCommandAsync(context, message, commandName, rawArgs, attachmentOwner);
        if (attachmentOwner is null && await runtime.GetOwnerAsync(context.SessionId) is null)
            throw new InvalidDataException("Session not found.");
        var parts = message.Parts ?? [new JsonObject { ["text"] = message.Text }];
        var item = new QueueItem(
            QueueItemType.User,
            SessionBoundary.ChannelInput(parts, context.Platform),
            ClientMessageId: message.ClientMessageId,
            // Direct user input; while the Session waits on a question it is the answer.
            OpenFields: InputSender.With(new JsonObject { ["userInput"] = true }, message.Sender)
        );
        if (attachmentOwner is null)
            await runtime.SubmitAndRunAsync(context.SessionId, item);
        else
            await runtime.SubmitAndRunAsync(attachmentOwner, item, beforeAdmission);
        return new(
            202,
            new JsonObject
            {
                ["accepted"] = true,
                ["note"] = "Queue save attempted; durable completion is not guaranteed.",
            }
        );
    }
}
