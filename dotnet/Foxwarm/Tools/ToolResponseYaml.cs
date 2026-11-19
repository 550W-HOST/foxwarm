using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

// YAML text for tool results: the port of packages/shared/src/toolResponseYaml.ts, which is the
// js-yaml 4.1.1 dumper restricted to JSON values (indent 2, lineWidth -1, noRefs, unsorted keys,
// single quoting, compat mode) with per-node layout decisions and literal blocks for every
// multi-line string in a block position. Output must equal the TypeScript text byte for byte;
// packages/shared/src/toolResponseFormatting.fixtures.json runs against both.
//
// Values follow JavaScript semantics, since the WebUI formats JSON.parse results: numbers are
// doubles written as Number.prototype.toString writes them, and object keys that are array
// indices come first in ascending order (Object.keys order).
internal static partial class ToolResponseYaml
{
    // The readable layout; any other value is js-yaml's flowLevel: block below that depth,
    // flow from it (-1: all block).
    internal const int Readable = int.MinValue;

    private readonly record struct Style(bool Block, bool Full);

    private enum ScalarStyle
    {
        Plain,
        Single,
        Literal,
        Double,
    }

    private static readonly HashSet<string> DeprecatedBooleans =
    [
        "y",
        "Y",
        "yes",
        "Yes",
        "YES",
        "on",
        "On",
        "ON",
        "n",
        "N",
        "no",
        "No",
        "NO",
        "off",
        "Off",
        "OFF",
    ];

    [GeneratedRegex(@"^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?\z", RegexOptions.CultureInvariant)]
    private static partial Regex DeprecatedBase60();

    [GeneratedRegex(
        @"^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex YamlFloat();

    [GeneratedRegex(@"^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\z", RegexOptions.CultureInvariant)]
    private static partial Regex YamlDate();

    [GeneratedRegex(
        @"^[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?\z",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex YamlTimestamp();

    [GeneratedRegex(@"^[-+]?[0-9]+e", RegexOptions.CultureInvariant)]
    private static partial Regex ScientificWithoutDot();

    internal static string Dump(JsonNode? value, int layout) =>
        WriteNode(layout, 0, value, true, true, false, Decide(layout, 0, value, false, false))
        ?? "";

    internal static bool ContainsMultilineString(JsonNode? value) =>
        value switch
        {
            JsonObject obj => obj.Any(pair => ContainsMultilineString(pair.Value)),
            JsonArray array => array.Any(ContainsMultilineString),
            JsonValue leaf => leaf.GetValueKind() == JsonValueKind.String
                && leaf.GetValue<string>().Contains('\n'),
            _ => false,
        };

    private static Style Decide(
        int layout,
        int level,
        JsonNode? value,
        bool parentIsSequence,
        bool full
    )
    {
        if (layout != Readable)
            return new(layout < 0 || layout > level, false);
        if (full || level == 0)
            return new(true, full);
        if (level == 1 && !parentIsSequence && value is JsonArray)
            return new(true, false);
        if (ContainsMultilineString(value))
            return new(true, true);
        return new(false, false);
    }

    private static string Indent(int level) => "\n" + new string(' ', 2 * level);

    private static string? WriteNode(
        int layout,
        int level,
        JsonNode? value,
        bool inBlock,
        bool compact,
        bool isKey,
        Style style
    )
    {
        switch (value)
        {
            case null:
                return "null";
            case JsonArray array:
                return style.Block && array.Count != 0
                    ? WriteBlockSequence(layout, level, array, compact, style.Full)
                    : WriteFlowSequence(layout, level, array);
            case JsonObject obj:
                return style.Block && obj.Count != 0
                    ? WriteBlockMapping(layout, level, obj, compact, style.Full)
                    : WriteFlowMapping(layout, level, obj);
        }
        var leaf = (JsonValue)value;
        return leaf.GetValueKind() switch
        {
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Null => "null",
            JsonValueKind.Number => RepresentNumber(NumberValue(leaf)),
            JsonValueKind.String => WriteScalar(
                leaf.GetValue<string>(),
                level,
                inBlock,
                isKey || !style.Block
            ),
            _ => null,
        };
    }

    private static string WriteFlowSequence(int layout, int level, JsonArray items)
    {
        var written = new List<string>();
        foreach (var item in items)
            if (WriteNode(layout, level, item, false, false, false, new(false, false)) is { } dump)
                written.Add(dump);
        return "[" + string.Join(", ", written) + "]";
    }

    private static string WriteBlockSequence(
        int layout,
        int level,
        JsonArray items,
        bool compact,
        bool full
    )
    {
        var result = new StringBuilder();
        foreach (var item in items)
        {
            var dump = WriteNode(
                layout,
                level + 1,
                item,
                true,
                true,
                false,
                Decide(layout, level + 1, item, true, full)
            );
            if (dump is null)
                continue;
            if (!compact || result.Length != 0)
                result.Append(Indent(level));
            result.Append(dump.StartsWith('\n') ? "-" : "- ").Append(dump);
        }
        return result.Length == 0 ? "[]" : result.ToString();
    }

    private static string WriteFlowMapping(int layout, int level, JsonObject obj)
    {
        var result = new StringBuilder();
        foreach (var (key, value) in OrderedEntries(obj))
        {
            var pair = result.Length != 0 ? ", " : "";
            var keyDump = WriteScalar(key, level, false, true);
            if (keyDump.Length > 1024)
                pair += "? ";
            var valueDump = WriteNode(layout, level, value, false, false, false, new(false, false));
            if (valueDump is null)
                continue;
            result.Append(pair).Append(keyDump).Append(": ").Append(valueDump);
        }
        return "{" + result + "}";
    }

    private static string WriteBlockMapping(
        int layout,
        int level,
        JsonObject obj,
        bool compact,
        bool full
    )
    {
        var result = new StringBuilder();
        foreach (var (key, value) in OrderedEntries(obj))
        {
            var pair = new StringBuilder();
            if (!compact || result.Length != 0)
                pair.Append(Indent(level));
            var keyDump = WriteScalar(key, level + 1, true, true);
            var explicitPair = keyDump.Length > 1024;
            if (explicitPair)
                pair.Append(keyDump.StartsWith('\n') ? "?" : "? ");
            pair.Append(keyDump);
            if (explicitPair)
                pair.Append(Indent(level));
            var valueDump = WriteNode(
                layout,
                level + 1,
                value,
                true,
                explicitPair,
                false,
                Decide(layout, level + 1, value, false, full)
            );
            if (valueDump is null)
                continue;
            pair.Append(valueDump.StartsWith('\n') ? ":" : ": ").Append(valueDump);
            result.Append(pair);
        }
        return result.Length == 0 ? "{}" : result.ToString();
    }

    // JavaScript Object.keys order: array-index keys ascending, then the rest in insertion order.
    private static IEnumerable<KeyValuePair<string, JsonNode?>> OrderedEntries(JsonObject obj)
    {
        var indices = new List<(uint Index, KeyValuePair<string, JsonNode?> Entry)>();
        var others = new List<KeyValuePair<string, JsonNode?>>();
        foreach (var pair in obj)
        {
            if (ArrayIndex(pair.Key) is uint index)
                indices.Add((index, pair));
            else
                others.Add(pair);
        }
        if (indices.Count == 0)
            return others;
        return indices.OrderBy(item => item.Index).Select(item => item.Entry).Concat(others);
    }

    private static uint? ArrayIndex(string key)
    {
        if (key.Length == 0 || key.Length > 10 || key.Length > 1 && key[0] == '0')
            return null;
        foreach (var character in key)
            if (character is < '0' or > '9')
                return null;
        var index = ulong.Parse(key, CultureInfo.InvariantCulture);
        return index < uint.MaxValue ? (uint)index : null;
    }

    internal static double NumberValue(JsonValue leaf) =>
        leaf.TryGetValue<double>(out var number)
            ? number
            : double.Parse(leaf.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture);

    private static string RepresentNumber(double value)
    {
        if (double.IsNaN(value))
            return ".nan";
        if (double.IsPositiveInfinity(value))
            return ".inf";
        if (double.IsNegativeInfinity(value))
            return "-.inf";
        if (value == 0 && double.IsNegative(value))
            return "-0.0";
        var text = JavaScriptNumber(value);
        if (Math.Floor(value) == value)
            return text;
        return ScientificWithoutDot().IsMatch(text) ? ReplaceFirst(text, "e", ".e") : text;
    }

    private static string ReplaceFirst(string text, string search, string replacement)
    {
        var index = text.IndexOf(search, StringComparison.Ordinal);
        return text[..index] + replacement + text[(index + search.Length)..];
    }

    // Number.prototype.toString(10): shortest round-trip digits in ECMAScript notation.
    internal static string JavaScriptNumber(double value)
    {
        if (double.IsNaN(value))
            return "NaN";
        if (double.IsInfinity(value))
            return value > 0 ? "Infinity" : "-Infinity";
        if (value == 0)
            return "0";
        var shortest = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponentAt = shortest.IndexOfAny(['E', 'e']);
        var mantissa = exponentAt < 0 ? shortest : shortest[..exponentAt];
        var exponent =
            exponentAt < 0
                ? 0
                : int.Parse(
                    shortest[(exponentAt + 1)..],
                    NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture
                );
        var point = mantissa.IndexOf('.');
        var digits = point < 0 ? mantissa : mantissa.Remove(point, 1);
        // value = 0.digits × 10^n
        var n = (point < 0 ? mantissa.Length : point) + exponent;
        var leading = 0;
        while (leading < digits.Length - 1 && digits[leading] == '0')
            leading++;
        digits = digits[leading..];
        n -= leading;
        digits = digits.TrimEnd('0');
        var k = digits.Length;
        string text;
        if (k <= n && n <= 21)
            text = digits + new string('0', n - k);
        else if (0 < n && n <= 21)
            text = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0)
            text = "0." + new string('0', -n) + digits;
        else
        {
            var e = n - 1;
            text =
                digits[..1]
                + (k > 1 ? "." + digits[1..] : "")
                + "e"
                + (e >= 0 ? "+" : "-")
                + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
        }
        return value < 0 ? "-" + text : text;
    }

    private static string WriteScalar(string text, int level, bool inBlock, bool singleLineOnly)
    {
        if (text.Length == 0)
            return "''";
        if (DeprecatedBooleans.Contains(text) || DeprecatedBase60().IsMatch(text))
            return "'" + text + "'";
        return ChooseScalarStyle(text, singleLineOnly, inBlock) switch
        {
            ScalarStyle.Plain => text,
            ScalarStyle.Single => "'" + text.Replace("'", "''", StringComparison.Ordinal) + "'",
            ScalarStyle.Literal => "|"
                + BlockHeader(text)
                + DropEndingNewline(IndentString(text, 2 * Math.Max(1, level))),
            _ => "\"" + EscapeString(text) + "\"",
        };
    }

    private static ScalarStyle ChooseScalarStyle(string text, bool singleLineOnly, bool inBlock)
    {
        if (!singleLineOnly && text.Contains('\n'))
            return ScalarStyle.Literal;
        var plain =
            IsPlainSafeFirst(CodePointAt(text, 0))
            && IsPlainSafeLast(CodePointAt(text, text.Length - 1));
        var previous = -1;
        for (var index = 0; index < text.Length; )
        {
            var character = CodePointAt(text, index);
            if (!IsPrintable(character))
                return ScalarStyle.Double;
            plain = plain && IsPlainSafe(character, previous, inBlock);
            previous = character;
            index += character >= 0x10000 ? 2 : 1;
        }
        return plain && !TestImplicitResolving(text) ? ScalarStyle.Plain : ScalarStyle.Single;
    }

    private static string BlockHeader(string text)
    {
        var leadingSpace = false;
        foreach (var character in text)
        {
            if (character == '\n')
                continue;
            leadingSpace = character == ' ';
            break;
        }
        var clip = text[^1] == '\n';
        var keep = clip && (text.Length >= 2 && text[^2] == '\n' || text == "\n");
        return (leadingSpace ? "2" : "") + (keep ? "+" : clip ? "" : "-") + "\n";
    }

    private static string DropEndingNewline(string text) =>
        text.Length > 0 && text[^1] == '\n' ? text[..^1] : text;

    // Indents every line; empty lines (\n only) are not indented.
    private static string IndentString(string text, int spaces)
    {
        var prefix = new string(' ', spaces);
        var result = new StringBuilder(text.Length + spaces * 4);
        var position = 0;
        while (position < text.Length)
        {
            var next = text.IndexOf('\n', position);
            var line = next == -1 ? text[position..] : text[position..(next + 1)];
            position = next == -1 ? text.Length : next + 1;
            if (line.Length > 0 && line != "\n")
                result.Append(prefix);
            result.Append(line);
        }
        return result.ToString();
    }

    private static string EscapeString(string text)
    {
        var result = new StringBuilder(text.Length + 8);
        for (var index = 0; index < text.Length; )
        {
            var character = CodePointAt(text, index);
            var escape = EscapeSequence(character);
            if (escape is null && IsPrintable(character))
            {
                result.Append(text[index]);
                if (character >= 0x10000)
                    result.Append(text[index + 1]);
            }
            else
                result.Append(escape ?? EncodeHex(character));
            index += character >= 0x10000 ? 2 : 1;
        }
        return result.ToString();
    }

    private static string? EscapeSequence(int character) =>
        character switch
        {
            0x00 => "\\0",
            0x07 => "\\a",
            0x08 => "\\b",
            0x09 => "\\t",
            0x0A => "\\n",
            0x0B => "\\v",
            0x0C => "\\f",
            0x0D => "\\r",
            0x1B => "\\e",
            0x22 => "\\\"",
            0x5C => "\\\\",
            0x85 => "\\N",
            0xA0 => "\\_",
            0x2028 => "\\L",
            0x2029 => "\\P",
            _ => null,
        };

    private static string EncodeHex(int character)
    {
        var hex = character.ToString("X", CultureInfo.InvariantCulture);
        var (handle, length) =
            character <= 0xFF ? ('x', 2)
            : character <= 0xFFFF ? ('u', 4)
            : ('U', 8);
        return "\\" + handle + new string('0', length - hex.Length) + hex;
    }

    private static int CodePointAt(string text, int position)
    {
        int first = text[position];
        if (first is >= 0xD800 and <= 0xDBFF && position + 1 < text.Length)
        {
            int second = text[position + 1];
            if (second is >= 0xDC00 and <= 0xDFFF)
                return (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000;
        }
        return first;
    }

    private static bool IsWhitespace(int character) => character is 0x20 or 0x09;

    private static bool IsPrintable(int character) =>
        character is >= 0x20 and <= 0x7E
        || character is >= 0xA1 and <= 0xD7FF and not 0x2028 and not 0x2029
        || character is >= 0xE000 and <= 0xFFFD and not 0xFEFF
        || character is >= 0x10000 and <= 0x10FFFF;

    private static bool IsNsCharOrWhitespace(int character) =>
        IsPrintable(character) && character is not 0xFEFF and not 0x0D and not 0x0A;

    private static bool IsPlainSafe(int character, int previous, bool inBlock)
    {
        var isNsCharOrWhitespace = IsNsCharOrWhitespace(character);
        var isNsChar = isNsCharOrWhitespace && !IsWhitespace(character);
        var safe = inBlock
            ? isNsCharOrWhitespace
            : isNsCharOrWhitespace
                && character is not ',' and not '[' and not ']' and not '{' and not '}';
        return safe && character != '#' && !(previous == ':' && !isNsChar)
            || IsNsCharOrWhitespace(previous) && !IsWhitespace(previous) && character == '#'
            || previous == ':' && isNsChar;
    }

    private static bool IsPlainSafeFirst(int character) =>
        IsPrintable(character)
        && character != 0xFEFF
        && !IsWhitespace(character)
        && character
            is not '-'
                and not '?'
                and not ':'
                and not ','
                and not '['
                and not ']'
                and not '{'
                and not '}'
                and not '#'
                and not '&'
                and not '*'
                and not '!'
                and not '|'
                and not '='
                and not '>'
                and not '\''
                and not '"'
                and not '%'
                and not '@'
                and not '`';

    private static bool IsPlainSafeLast(int character) =>
        !IsWhitespace(character) && character != ':';

    private static bool TestImplicitResolving(string text) =>
        text
            is "~"
                or "null"
                or "Null"
                or "NULL"
                or "true"
                or "True"
                or "TRUE"
                or "false"
                or "False"
                or "FALSE"
                or "<<"
        || ResolvesInteger(text)
        || YamlFloat().IsMatch(text) && text[^1] != '_'
        || YamlDate().IsMatch(text)
        || YamlTimestamp().IsMatch(text);

    // js-yaml's integer resolver: decimal, 0b/0o/0x forms and underscores, with an optional sign.
    private static bool ResolvesInteger(string text)
    {
        var max = text.Length;
        if (max == 0)
            return false;
        var index = 0;
        var hasDigits = false;
        char? character = text[index];
        if (character is '-' or '+')
            character = ++index < max ? text[index] : null;
        if (character == '0')
        {
            if (index + 1 == max)
                return true;
            character = text[++index];
            Func<char, bool>? digit = character switch
            {
                'b' => value => value is '0' or '1',
                'x' => char.IsAsciiHexDigit,
                'o' => value => value is >= '0' and <= '7',
                _ => null,
            };
            if (digit is not null)
            {
                for (index++; index < max; index++)
                {
                    character = text[index];
                    if (character == '_')
                        continue;
                    if (!digit(text[index]))
                        return false;
                    hasDigits = true;
                }
                return hasDigits && character != '_';
            }
        }
        if (character == '_')
            return false;
        for (; index < max; index++)
        {
            character = text[index];
            if (character == '_')
                continue;
            if (character is not (>= '0' and <= '9'))
                return false;
            hasDigits = true;
        }
        return hasDigits && character != '_';
    }
}
