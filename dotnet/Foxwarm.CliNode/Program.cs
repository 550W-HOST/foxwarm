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
            var options = Parse(args);
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

    private static NodeClientOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>();
        var localTrigger = true;
        for (var index = 0; index < args.Length; index++)
        {
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
        return new NodeClientOptions(
            host,
            values.GetValueOrDefault("--id"),
            values.GetValueOrDefault("--token"),
            values.GetValueOrDefault("--auth-token"),
            values.GetValueOrDefault("--credentials-file"),
            localTrigger,
            TriggerPort(values.GetValueOrDefault("--local-trigger-port"))
        );
    }

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
