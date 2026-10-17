namespace Foxwarm.Tools;

internal static class ExactReplacement
{
    internal static (int Occurrences, string? Updated) Apply(
        string text,
        string search,
        string replacement
    )
    {
        var count = 0;
        if (search.Length == 0)
            count = text.Length + 1;
        else
            for (
                var index = 0;
                (index = text.IndexOf(search, index, StringComparison.Ordinal)) >= 0;
                index += search.Length
            )
                count++;
        return (
            count,
            count != 1 ? null
            : search.Length == 0 ? replacement
            : text.Replace(search, replacement, StringComparison.Ordinal)
        );
    }
}
