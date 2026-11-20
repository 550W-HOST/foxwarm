using System.Text.RegularExpressions;

namespace Foxwarm.Tests;

// Structure of exec receipts and completion events, without their editorial wording: the
// first line starts with the bracketed execId, and output follows it directly.
internal static class ExecReceipt
{
    private static readonly Regex Leading = new(@"^\[([A-Za-z0-9_-]+)\] \S");

    // Asserts a background receipt or completion header and returns its first line.
    internal static string Header(string text)
    {
        var first = text.Split('\n')[0];
        Assert.Matches(Leading, first);
        return first;
    }

    internal static string Id(string text) => Leading.Match(text).Groups[1].Value;

    // The header line after its `[execId] ` prefix: outcome, exit code and duration.
    internal static string Summary(string text)
    {
        var header = Header(text);
        return header[(header.IndexOf("] ", StringComparison.Ordinal) + 2)..];
    }

    // Whether the summary states this exit code: a lone number that is not the duration.
    internal static void ExitCode(string text, int code) =>
        Assert.Matches($@"(?<![\d.]){code}(?![\d.]|m?s\b)", Summary(text));
}
