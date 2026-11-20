using Foxwarm.Models;

namespace Foxwarm.DevTools;

internal static class TextRedactionStatsCommand
{
    internal static void Run(string[] args)
    {
        if (args.Length is < 1 or > 2)
            throw new ArgumentException("Usage: text-redaction-stats DATA_ROOT [STORE_PATH]");
        try
        {
            Console.WriteLine(
                TextRedactionStore
                    .KnownStatistics(args[0], args.Length == 2 ? args[1] : null)
                    .ToJsonText()
            );
        }
        catch (Exception)
        {
            // Exceptions from key/SQLite decoding are not a public data surface.
            Console.Error.WriteLine(
                "Text redaction statistics could not be read. Check the existing instance key and store files."
            );
            Environment.ExitCode = 1;
        }
    }
}
