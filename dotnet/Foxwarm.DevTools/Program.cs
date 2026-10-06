using Foxwarm.DevTools;

if (args.Length == 0)
    throw new ArgumentException(
        "Usage: Foxwarm.DevTools <conditional-memory|responses-request|responses-stream|session-restart> [arguments]"
    );

var commandArgs = args[1..];
switch (args[0])
{
    case "conditional-memory":
        await ConditionalMemoryCommand.RunAsync(commandArgs);
        break;
    case "responses-request":
        await ResponsesRequestCommand.RunAsync(commandArgs);
        break;
    case "responses-stream":
        await ResponsesStreamCommand.RunAsync(commandArgs);
        break;
    case "catalog-import-dotnet-v1":
        if (commandArgs.Length != 3 || commandArgs[2] != "--declare-pre-catalog-dotnet-v1")
            throw new ArgumentException(
                "Usage: catalog-import-dotnet-v1 ROOT WORKSPACE --declare-pre-catalog-dotnet-v1"
            );
        Console.WriteLine(
            System.Text.Json.JsonSerializer.Serialize(
                new
                {
                    imported = Foxwarm.Sessions.SessionCatalogImport.ImportPreCatalogDotNetV1(
                        commandArgs[0],
                        commandArgs[1]
                    ),
                }
            )
        );
        break;
    case "session-restart":
        await SessionRestartCommand.RunAsync(commandArgs);
        break;
    default:
        throw new ArgumentException($"Unknown development command: {args[0]}");
}
