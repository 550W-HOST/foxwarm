using System.Runtime.InteropServices;

namespace Foxwarm.CliNode;

internal static class Program
{
    internal static async Task<int> Main(string[] args)
    {
        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, signal) => { signal.Cancel = true; stop.Cancel(); };
        using var termination = !OperatingSystem.IsWindows()
            ? PosixSignalRegistration.Create(PosixSignal.SIGTERM, signal => { signal.Cancel = true; stop.Cancel(); })
            : null;
        try
        {
            var options = Parse(args);
            await new NodeClient(options, new NodePaths(Environment.CurrentDirectory)).Run(stop.Token);
            return 0;
        }
        catch (Exception error)
        {
            // Do not print transport/URI exceptions containing authentication query parameters.
            Console.Error.WriteLine(error is InvalidDataException ? error.Message : "Node client failed: " + error.GetType().Name);
            return 1;
        }
    }

    private static NodeClientOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>();
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--no-local-trigger")
                continue;
            if (args[index] is not ("--host" or "--id" or "--token" or "--auth-token" or "--credentials-file") || index + 1 >= args.Length)
                throw new InvalidDataException("Unsupported or incomplete option: " + args[index] + ". This headless client implements connection and file tools only.");
            values[args[index]] = args[++index];
        }
        var host = values.GetValueOrDefault("--host");
        if (string.IsNullOrEmpty(host))
            throw new InvalidDataException("--host is required");
        if (!values.ContainsKey("--token") && !(values.ContainsKey("--auth-token") && values.ContainsKey("--id")) && !values.ContainsKey("--credentials-file"))
            throw new InvalidDataException("Provide --token, or (--auth-token with --id), or --credentials-file with stored node credentials");
        return new NodeClientOptions(host, values.GetValueOrDefault("--id"), values.GetValueOrDefault("--token"), values.GetValueOrDefault("--auth-token"), values.GetValueOrDefault("--credentials-file"));
    }
}
