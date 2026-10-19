using System.Text.Json.Nodes;

namespace Foxwarm.CliNode;

internal sealed partial class NodeClient
{
    private static async Task DispatchService(Connection connection, JsonObject frame)
    {
        var service = Text(frame, "service") ?? "";
        var operation = Text(frame, "operation") ?? "";
        var command = Text(frame, "type") == "node_service_command";
        try
        {
            var result = await NodeCodeServices.Execute(service, operation, frame["args"] as JsonObject);
            if (!command)
                await connection.Send(new JsonObject
                {
                    ["type"] = "node_service_response",
                    ["requestId"] = Text(frame, "requestId") ?? "",
                    ["result"] = result,
                });
        }
        catch (Exception error)
        {
            if (!command)
                await connection.Send(new JsonObject
                {
                    ["type"] = "node_service_error",
                    ["requestId"] = Text(frame, "requestId") ?? "",
                    ["error"] = NodeCodeServices.Error(error),
                });
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
                await connection.Send(new JsonObject
                {
                    ["type"] = "node_service_event",
                    ["service"] = service,
                    ["event"] = detail,
                });
            }
        }
    }
}
