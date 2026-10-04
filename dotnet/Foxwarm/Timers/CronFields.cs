using System.Globalization;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Timers;

// Forward field parsing derived from cron-parser 4.9.0. See THIRD-PARTY-NOTICES.md.
internal readonly record struct CronValue(double? Number, string? Constraint)
{
    internal static CronValue From(double value) => new(value, null);
    internal static CronValue From(string value) => new(null, value);
    internal bool Last => Constraint?.Contains('L') == true;
}

internal sealed class CronFields
{
    internal static readonly int[] MonthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    internal readonly CronValue[][] Values;
    internal readonly double Nth;
    private static readonly int[] Minimum = [0, 0, 0, 1, 1, 0], Maximum = [59, 59, 23, 31, 12, 7];
    private static readonly string[] Names = ["second", "minute", "hour", "dayOfMonth", "month", "dayOfWeek"];
    private static readonly string[] Defaults = ["0", "*", "*", "*", "*", "*"];
    private const string Space = "[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static readonly Dictionary<string, string> Macros = new(StringComparer.Ordinal)
    { ["@yearly"] = "0 0 1 1 *", ["@monthly"] = "0 0 1 * *", ["@weekly"] = "0 0 * * 0", ["@daily"] = "0 0 * * *", ["@hourly"] = "0 * * * *" };
    private static readonly string[] Months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    private static readonly string[] Weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    private CronFields(CronValue[][] values, double nth) { Values = values; Nth = nth; }

    internal static CronFields Parse(string expression)
    {
        if (Macros.TryGetValue(expression, out var predefined)) expression = predefined;
        var atoms = Regex.Split(SessionGoal.Trim(expression), Space + "+");
        if (atoms.Length > 6) throw Invalid("Invalid cron expression");
        var values = new CronValue[6][]; var start = 6 - atoms.Length; double nth = 0;
        for (var index = 0; index < 6; index++)
        {
            var text = index < start ? Defaults[index] : atoms[index - start];
            if (text.Length == 0) text = Defaults[index];
            else if (index == 5)
            {
                var pieces = text.Split('#');
                if (pieces.Length > 1)
                {
                    nth = Number(pieces[^1]);
                    if (text.Contains(',') || text.Contains('/') || text.Contains('-') || pieces.Length > 2 || double.IsNaN(nth) || nth < 1 || nth > 5)
                        throw Invalid("Invalid dayOfWeek occurrence number (#)");
                    text = pieces[0];
                }
            }
            values[index] = ParseField(index, text);
        }
        if (values[4].Length == 1)
        {
            var limit = MonthDays[(int)values[4][0].Number!.Value - 1];
            if (values[3].Length > 0 && values[3][0].Number is double first && first > limit)
                throw Invalid("Invalid explicit day of month definition");
            values[3] = values[3].Where(value => value.Constraint == "L" || value.Number is double day && day <= limit).ToArray();
        }
        return new(values, nth);
    }

    private static CronValue[] ParseField(int index, string value)
    {
        if (index is 4 or 5)
            value = Regex.Replace(value, "[a-z]{3}", match =>
            {
                var names = index == 4 ? Months : Weekdays;
                var found = Array.IndexOf(names, match.Value.ToLowerInvariant());
                if (found < 0) throw Invalid("Cannot resolve alias " + match.Value);
                return (found + (index == 4 ? 1 : 0)).ToString(CultureInfo.InvariantCulture);
            }, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var valid = index == 5 ? "^[?,*0-9L#/-]+$" : index == 3 ? "^[?,*0-9L/-]+$" : "^[,*0-9/-]+$";
        if (!Regex.IsMatch(value, valid, RegexOptions.CultureInvariant)) throw Invalid("Invalid characters in " + Names[index]);
        var range = Minimum[index] + "-" + Maximum[index];
        if (value.Contains('*')) value = value.Replace("*", range, StringComparison.Ordinal);
        else if (value.Contains('?')) value = value.Replace("?", range, StringComparison.Ordinal);
        var result = new List<CronValue>();
        foreach (var atom in value.Split(','))
        {
            if (atom.Length == 0) throw Invalid("Invalid list value format");
            var repeats = atom.Split('/');
            if (repeats.Length > 2) throw Invalid("Invalid repeat");
            var interval = repeats.Length == 1 ? 1 : Number(repeats[1]);
            var from = repeats[0];
            if (repeats.Length > 1 && !double.IsNaN(Number(from))) from += "-" + Maximum[index];
            var bounds = from.Split('-');
            if (bounds.Length > 1 && bounds[0].Length > 0)
            {
                var min = Number(bounds[0]); var max = Number(bounds[1]);
                if (double.IsNaN(min) || double.IsNaN(max) || min < Minimum[index] || max > Maximum[index]) throw Invalid("Invalid range constraints");
                if (min > max) throw Invalid("Invalid range");
                if (double.IsNaN(interval) || interval <= 0) throw Invalid("Invalid repeat interval");
                var stack = new List<double>(); var repeatIndex = interval;
                if (index == 5 && max % 7 == 0) stack.Add(0);
                for (var cursor = min; cursor <= max; cursor++)
                {
                    if (!stack.Contains(cursor) && repeatIndex > 0 && repeatIndex % interval == 0) { repeatIndex = 1; stack.Add(cursor); }
                    else repeatIndex++;
                }
                result.AddRange(stack.Select(CronValue.From));
            }
            else
            {
                if (bounds.Length > 1 && bounds[0].Length == 0 && bounds[1].Length == 0) throw Invalid("Invalid range");
                if (index is 3 or 5 && from.Contains('L')) result.Add(CronValue.From(from));
                else
                {
                    var number = Number(from);
                    if (double.IsNaN(number) || number < Minimum[index] || number > Maximum[index]) throw Invalid("Invalid field constraints");
                    if (index == 5) number %= 7;
                    result.Add(CronValue.From(number));
                }
            }
        }
        return result.OrderBy(value => value.Number is null ? 1 : 0).ThenBy(value => value.Number).ThenBy(value => value.Constraint, StringComparer.Ordinal).ToArray();
    }
    internal static double Number(string text)
    {
        text = SessionGoal.Trim(text); if (text.Length == 0) return 0;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || text.StartsWith("0b", StringComparison.OrdinalIgnoreCase) || text.StartsWith("0o", StringComparison.OrdinalIgnoreCase))
        {
            var radix = char.ToLowerInvariant(text[1]) switch { 'x' => 16, 'b' => 2, _ => 8 }; double result = 0;
            if (text.Length == 2) return double.NaN;
            foreach (var ch in text[2..])
            {
                var digit = ch is >= '0' and <= '9' ? ch - '0' : ch is >= 'a' and <= 'f' ? ch - 'a' + 10 : ch is >= 'A' and <= 'F' ? ch - 'A' + 10 : -1;
                if (digit < 0 || digit >= radix) return double.NaN; result = result * radix + digit;
            }
            return result;
        }
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : double.NaN;
    }
    internal static bool Match(int value, CronValue[] sequence)
    {
        foreach (var item in sequence) if (item.Number is double number && number >= value) return number == value;
        return sequence.Length > 0 && sequence[0].Number == value;
    }
    internal static InvalidDataException Invalid(string message) => new(message);
}
