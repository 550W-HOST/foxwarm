using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    private Task DispatchService(Connection connection, JsonObject frame) =>
        NodeServiceDispatch.Dispatch(frame, pty, connection, value => connection.Send(value));
}

// Executes one fixed Code/Terminal service frame and produces its reply frames. Shared by the
// authenticated WebSocket client and the stdio mode, which differ only in the sink for frames.
internal static class NodeServiceDispatch
{
    internal static string? Text(JsonObject frame, string key) => NodeFileTools.Text(frame[key]);

    internal static async Task Dispatch(
        JsonObject frame,
        NodePtyService? pty,
        object owner,
        Func<JsonObject, Task> send
    )
    {
        var service = Text(frame, "service") ?? "";
        var operation = Text(frame, "operation") ?? "";
        var command = Text(frame, "type") == "node_service_command";
        try
        {
            Task Reply(JsonObject result) =>
                command
                    ? Task.CompletedTask
                    : send(
                        new JsonObject
                        {
                            ["type"] = "node_service_response",
                            ["requestId"] = Text(frame, "requestId") ?? "",
                            ["result"] = result,
                        }
                    );
            if (service == "vscode-pty" && pty is not null)
                await pty.Dispatch(operation, frame["args"] as JsonObject ?? new(), owner, Reply);
            else
                await Reply(
                    await NodeCodeServices.Execute(service, operation, frame["args"] as JsonObject)
                );
        }
        catch (Exception error)
        {
            if (!command)
                await send(
                    new JsonObject
                    {
                        ["type"] = "node_service_error",
                        ["requestId"] = Text(frame, "requestId") ?? "",
                        ["error"] = NodeCodeServices.Error(error),
                    }
                );
            else
            {
                var detail = new JsonObject
                {
                    ["type"] = "error",
                    ["operation"] = operation,
                    ["error"] = NodeCodeServices.Error(error),
                };
                if (Text(frame["args"] as JsonObject ?? new(), "terminalId") is { } terminal)
                    detail["terminalId"] = terminal;
                await send(
                    new JsonObject
                    {
                        ["type"] = "node_service_event",
                        ["service"] = service,
                        ["event"] = detail,
                    }
                );
            }
        }
    }
}
