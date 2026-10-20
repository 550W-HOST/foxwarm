using Foxwarm.Tools;
using System.Runtime.InteropServices;

namespace Foxwarm.CliNode;

internal static class Program
{
    internal static async Task<int> Main(string[] args)
    {
        if (await Foxwarm.Terminal.NativeHelperEntry.TryRunAsync(args))
            return Environment.ExitCode;
        if (await LocalTriggerHelper.TryRun(args) is int triggerExit)
            return triggerExit;
        if (ExecNative.Helper(args) is int helperExit)
            return helperExit;
        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, signal) =>
        {
            signal.Cancel = true;
            stop.Cancel();
        };
        using var termination = !OperatingSystem.IsWindows()
            ? PosixSignalRegistration.Create(
                PosixSignal.SIGTERM,
                signal =>
                {
                    signal.Cancel = true;
                    stop.Cancel();
                }
            )
            : null;
        try
        {
            if (args.Contains("--help") || args.Contains("-h"))
            {
                Console.WriteLine(Help);
                return 0;
            }
            var (options, interactive) = Parse(args);
            if (interactive is not null)
                await ConsoleNode.Run(options, interactive, stop.Token);
            else
                await new NodeClient(options, new NodePaths(Environment.CurrentDirectory)).Run(
                    stop.Token
                );
            return 0;
        }
        catch (Exception error)
        {
            // Do not print transport/URI exceptions containing authentication query parameters.
            Console.Error.WriteLine(
                error is InvalidDataException
                    ? error.Message
                    : "Node client failed: " + error.GetType().Name
            );
            return 1;
        }
    }

    private static (NodeClientOptions Client, InteractiveOptions? Interactive) Parse(string[] args)
    {
        var values = new Dictionary<string, string>();
        var localTrigger = true;
        var interactive = false;
        var autoAll = false;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--interactive")
            {
                interactive = true;
                continue;
            }
            if (args[index] == "--auto-approve-all")
            {
                autoAll = true;
                continue;
            }
            if (args[index] == "--no-local-trigger")
            {
                localTrigger = false;
                continue;
            }
            if (
                args[index]
                    is not (
                        "--host"
                        or "--id"
                        or "--token"
                        or "--auth-token"
                        or "--credentials-file"
                        or "--local-trigger-port"
                        or "--auto-approve"
                        or "--timeout"
                    )
                || index + 1 >= args.Length
            )
                throw new InvalidDataException(
                    "Unsupported or incomplete option: " + args[index] + "."
                );
            values[args[index]] = args[++index];
        }
        var host = values.GetValueOrDefault("--host");
        if (string.IsNullOrEmpty(host))
            throw new InvalidDataException("--host is required");
        if (
            !values.ContainsKey("--token")
            && !(values.ContainsKey("--auth-token") && values.ContainsKey("--id"))
            && !values.ContainsKey("--credentials-file")
        )
            throw new InvalidDataException(
                "Provide --token, or (--auth-token with --id), or --credentials-file with stored node credentials"
            );
        if (
            !interactive
            && (autoAll || values.ContainsKey("--auto-approve") || values.ContainsKey("--timeout"))
        )
            throw new InvalidDataException("Approval options require --interactive");
        return (
            new NodeClientOptions(
                host,
                values.GetValueOrDefault("--id"),
                values.GetValueOrDefault("--token"),
                values.GetValueOrDefault("--auth-token"),
                values.GetValueOrDefault("--credentials-file"),
                localTrigger,
                TriggerPort(values.GetValueOrDefault("--local-trigger-port"))
            ),
            interactive
                ? new InteractiveOptions(
                    autoAll,
                    values.GetValueOrDefault("--auto-approve"),
                    TriggerPort(values.GetValueOrDefault("--timeout"))
                )
                : null
        );
    }

    private const string Help = """
        Foxwarm CLI Node

        Usage: Foxwarm.CliNode --host URL [credentials] [options]

        Credentials:
          --token TOKEN                 Pairing token
          --id NAME                     Requested name or approved Node ID
          --auth-token TOKEN            Approved auth token (requires --id)
          --credentials-file PATH       Load/save approved credentials

        Options:
          --interactive                 Show bound Sessions, history and tool approvals
          --auto-approve PATTERN        Interactive: match tool names with a case-insensitive
                                        .NET ECMAScript regular expression (culture invariant).
                                        Empty means manual; invalid patterns fail startup.
          --auto-approve-all            Interactive: approve future ordinary tool calls
          --timeout SECONDS             Interactive: fallback approval deadline when the server
                                        supplies none. Positive deadlines reject 2 seconds early,
                                        with a 1-second minimum. The server deadline takes priority.
                                        This does not set an exec command's foreground wait.
          --local-trigger-port PORT     Loopback trigger port (default: OS-selected)
          --no-local-trigger            Disable the loopback trigger
          --help, -h                    Show this help

        Native default: headless.
        Interactive keys: Up/Down select, Enter send, Backspace/Delete erase,
          Ctrl+R refresh, Ctrl+C quit; q quits only with an empty draft and no approval.
          During approval: Y/Enter approve, N/Esc reject, A toggles future auto-approval.
          A does not decide the displayed request. Text batches are not shortcut keys.
        """;

    private static double TriggerPort(string? text)
    {
        text = NodePaths.TrimSpace(text ?? "");
        double port;
        if (text.Length > 2 && text[0] == '0' && "xXbBoO".Contains(text[1]))
        {
            var radix = char.ToLowerInvariant(text[1]) switch
            {
                'x' => 16,
                'b' => 2,
                _ => 8,
            };
            port = 0;
            foreach (var digit in text.AsSpan(2))
            {
                var number =
                    digit is >= '0' and <= '9' ? digit - '0'
                    : digit is >= 'a' and <= 'f' ? digit - 'a' + 10
                    : digit is >= 'A' and <= 'F' ? digit - 'A' + 10
                    : -1;
                if (number < 0 || number >= radix)
                    return 0;
                port = port * radix + number;
            }
        }
        else if (
            !double.TryParse(
                text,
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out port
            )
        )
            return 0;
        return double.IsFinite(port) ? port : 0;
    }
}
