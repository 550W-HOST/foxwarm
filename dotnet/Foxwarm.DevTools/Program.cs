using Foxwarm.DevTools;

if (args.Length == 0)
    throw new ArgumentException(
        "Usage: Foxwarm.DevTools <conditional-memory|responses-request|responses-stream|journal|session-restart> [arguments]"
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
    case "journal":
        await JournalCommand.RunAsync(commandArgs);
        break;
    case "session-restart":
        await SessionRestartCommand.RunAsync(commandArgs);
        break;
    default:
        throw new ArgumentException($"Unknown development command: {args[0]}");
}
