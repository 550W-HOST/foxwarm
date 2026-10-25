using Foxwarm.Models;

namespace Foxwarm.DevTools;

internal static class MainLogFixtureCommand
{
    internal static async Task RunAsync(string[] args)
    {
        var configuration = new ModelConfiguration(args[0]);
        TextWriter retainedOutput;
        TextWriter retainedError;
        using (var log = new MainLog(configuration))
        {
            retainedOutput = Console.Out;
            retainedError = Console.Error;
            using var start = new Barrier(3);
            var output = Task.Factory.StartNew(
                () =>
                {
                    start.SignalAndWait();
                    for (var index = 0; index < 10000; index++)
                    {
                        Console.WriteLine("ordinary startup " + index);
                        if (index % 64 == 0)
                            Console.Out.Flush();
                    }
                },
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default
            );
            var errors = Task.Factory.StartNew(
                () =>
                {
                    start.SignalAndWait();
                    for (var index = 0; index < 10000; index++)
                    {
                        Console.Error.WriteLine(
                            "timer diagnostic " + index + "\n   at supported delivery"
                        );
                        if (index % 64 == 0)
                            Console.Error.Flush();
                    }
                },
                CancellationToken.None,
                TaskCreationOptions.LongRunning,
                TaskScheduler.Default
            );
            start.SignalAndWait();
            await Task.WhenAll(output, errors);
            if (args[1] != "failed-file")
                File.WriteAllText(
                    Path.Combine(args[0], "completed-records"),
                    File.ReadLines(MainLog.Destination(configuration)).Count().ToString()
                );
            Console.Write("partial stdout");
            Console.Error.Write("partial stderr");
            Console.Out.Flush();
            Console.Error.Flush();
        }
        retainedOutput.WriteLine("retained stdout");
        retainedError.WriteLine("retained stderr");
    }
}