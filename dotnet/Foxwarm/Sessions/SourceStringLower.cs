using System.Text;

namespace Foxwarm.Sessions;

// Locale-independent full lowercasing used by the source JS search verifier.
internal static partial class SourceStringLower
{
    internal static string Lower(string text)
    {
        var input = new List<int>();
        for (var index = 0; index < text.Length; index++)
        {
            var code = (int)text[index];
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1])) code = char.ConvertToUtf32(text[index], text[++index]);
            input.Add(code);
        }
        var output = new StringBuilder(text.Length);
        for (var index = 0; index < input.Count; index++)
        {
            var code = input[index];
            if (code == 0x130) { output.Append("i\u0307"); continue; }
            if (code == 0x3a3 && FinalSigma(input, index)) code = 0x3c2;
            else code = Map(code);
            if (code <= 0xffff) output.Append((char)code); else output.Append(char.ConvertFromUtf32(code));
        }
        return output.ToString();
    }
    private static bool Contains((int Start, int End)[] ranges, int value)
    {
        var lo = 0; var hi = ranges.Length - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) / 2; var range = ranges[mid];
            if (value < range.Start) hi = mid - 1; else if (value > range.End) lo = mid + 1; else return true;
        }
        return false;
    }
    private static int Map(int value)
    {
        var lo = 0; var hi = Mappings.Length - 1;
        while (lo <= hi)
        {
            var mid = (lo + hi) / 2; var range = Mappings[mid];
            if (value < range.Start) hi = mid - 1; else if (value > range.End) lo = mid + 1;
            else return (value - range.Start) % range.Step == 0 ? value + range.Delta : value;
        }
        return value;
    }
    private static bool FinalSigma(List<int> input, int index)
    {
        var before = index - 1; while (before >= 0 && Contains(Ignorable, input[before])) before--;
        if (before < 0 || !Contains(Cased, input[before])) return false;
        var after = index + 1; while (after < input.Count && Contains(Ignorable, input[after])) after++;
        return after == input.Count || !Contains(Cased, input[after]);
    }
}
