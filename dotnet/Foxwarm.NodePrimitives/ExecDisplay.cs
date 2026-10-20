using System.Globalization;
using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

// Source's exec display contract; raw programmatic capture never passes through this formatter.
internal static class ExecDisplay
{
    internal sealed record Excerpt(string Text, bool Truncated, string[] Notes);

    private static string[] Characters(string value) =>
        StringInfo.GetTextElementEnumerator(value).AsEnumerable().ToArray();

    private static IEnumerable<string> AsEnumerable(this TextElementEnumerator iterator)
    {
        while (iterator.MoveNext())
            yield return iterator.GetTextElement();
    }

    private static string Start(string value, int count) =>
        string.Concat(Characters(value).Take(Math.Max(0, count)));

    private static string End(string value, int count) =>
        string.Concat(Characters(value).TakeLast(Math.Max(0, count)));

    private static int Length(string value) => new StringInfo(value).LengthInTextElements;

    internal static Excerpt Truncate(
        string text,
        int maximum,
        bool force,
        string reason = "this file is too long"
    )
    {
        var originalCount = Length(text);
        if (!force && originalCount <= maximum)
            return new(text, false, []);
        var lines = text.Length == 0 ? [] : Regex.Split(text, "\\r\\n|\\n|\\r");
        var originalLines = lines.Length;
        var shortened = 0;
        for (var index = 0; index < lines.Length; index++)
        {
            var length = Length(lines[index]);
            if (length <= 550)
                continue;
            shortened++;
            lines[index] =
                Start(lines[index], 250)
                + $"...[foxwarm: line too long ({length} chars at line {index + 1})]..."
                + End(lines[index], 250);
        }
        var output = string.Join('\n', lines);
        var omitted = 0;
        var begin = 0;
        var end = 0;
        if (Length(output) > maximum)
        {
            if (lines.Length <= 1)
            {
                var line = lines.FirstOrDefault() ?? "";
                var marker = $"[foxwarm: 0 lines (line range 1-1) omitted because {reason}]";
                var available = Math.Max(0, maximum - Length(marker));
                var head = (available + 1) / 2;
                output = Start(line, head) + marker + End(line, available - head);
            }
            else
            {
                var headBudget = (int)Math.Floor(maximum * 0.62);
                var tailBudget = maximum - headBudget;
                var headCount = 0;
                var tailCount = 0;
                var used = 0;
                while (headCount < lines.Length - 1)
                {
                    var next = Length(lines[headCount]) + (headCount > 0 ? 1 : 0);
                    if (used + next > headBudget)
                        break;
                    used += next;
                    headCount++;
                }
                used = 0;
                while (tailCount < lines.Length - headCount - 1)
                {
                    var next =
                        Length(lines[lines.Length - 1 - tailCount]) + (tailCount > 0 ? 1 : 0);
                    if (used + next > tailBudget)
                        break;
                    used += next;
                    tailCount++;
                }
                string Build()
                {
                    omitted = lines.Length - headCount - tailCount;
                    begin = headCount + 1;
                    end = lines.Length - tailCount;
                    var marker =
                        $"--- [foxwarm: {omitted} lines (line range {begin}-{end}) omitted because {reason}] ---";
                    return string.Join(
                        '\n',
                        lines.Take(headCount).Append(marker).Concat(lines.TakeLast(tailCount))
                    );
                }
                output = Build();
                while (Length(output) > maximum && (headCount > 0 || tailCount > 0))
                {
                    if (tailCount > 0 && (tailCount >= headCount || headCount == 0))
                        tailCount--;
                    else if (headCount > 0)
                        headCount--;
                    else
                        tailCount--;
                    output = Build();
                }
            }
        }
        var notes = new List<string>();
        if (shortened > 0 || omitted > 0)
        {
            var kinds = new List<string>();
            if (shortened > 0)
                kinds.Add("line-too-long placeholders");
            if (omitted > 0)
                kinds.Add("line-range omission placeholders");
            notes.Add(
                $"Foxwarm placeholders above ({string.Join(", ", kinds)}) are not original output content."
            );
        }
        if (omitted > 0)
            notes.Add(
                $"Omitted {omitted} line(s) from original line range {begin}-{end} because {reason}."
            );
        notes.Add($"Original output: {originalLines} line(s), {originalCount} character(s).");
        return new(output, true, notes.ToArray());
    }
}
