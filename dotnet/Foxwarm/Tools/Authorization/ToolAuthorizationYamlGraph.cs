using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.RepresentationModel;

namespace Foxwarm.Tools;

// Keep alias references instead of expanding them. Merge copies the keys available at its
// parse position, including the source parser's partial-anchor and explicit-key precedence.
internal sealed class PolicyYamlNode
{
    internal YamlScalarNode? Scalar;
    internal Dictionary<string, PolicyYamlNode>? Map;
    internal List<PolicyYamlNode>? List;
    internal string Tag = "";
}
internal static class ToolAuthorizationYamlGraph
{
    private sealed class Frame(PolicyYamlNode value)
    {
        internal readonly PolicyYamlNode Value = value;
        internal PolicyYamlNode? Key;
        internal readonly HashSet<string> Overridable = new(StringComparer.Ordinal);
    }
    internal static PolicyYamlNode Parse(string text)
    {
        var parser = new Parser(new StringReader(text)); var stack = new Stack<Frame>();
        var anchors = new Dictionary<string, PolicyYamlNode>(StringComparer.Ordinal); PolicyYamlNode? root = null; var documents = 0;
        void Attach(PolicyYamlNode value)
        {
            if (stack.Count == 0) { if (root is not null) throw new InvalidDataException("Multiple YAML policy roots."); root = value; return; }
            var frame = stack.Peek();
            if (frame.Value.List is { } list) { list.Add(value); return; }
            if (frame.Key is null) { frame.Key = value; return; }
            var key = frame.Key; frame.Key = null;
            if (MergeKey(key))
            {
                var sources = value.List ?? [value];
                foreach (var source in sources)
                {
                    if (source.Scalar is not null && !ObjectScalar(source.Scalar)) throw new InvalidDataException("Invalid YAML merge source.");
                    foreach (var pair in ObjectEntries(source))
                        if (frame.Value.Map!.TryAdd(pair.Key, pair.Value)) frame.Overridable.Add(pair.Key);
                }
                return;
            }
            var name = Key(key);
            if (frame.Value.Map!.ContainsKey(name) && !frame.Overridable.Remove(name)) throw new InvalidDataException("Duplicate YAML policy key.");
            frame.Value.Map[name] = value;
        }
        while (parser.MoveNext())
        {
            switch (parser.Current)
            {
                case DocumentStart: if (++documents != 1) throw new InvalidDataException("Tool policy requires one document."); break;
                case MappingStart map:
                    var mapping = new PolicyYamlNode { Map = new(StringComparer.Ordinal), Tag = map.Tag.IsEmpty ? "" : map.Tag.Value };
                    if (mapping.Tag is not ("" or "!" or "tag:yaml.org,2002:map" or "tag:yaml.org,2002:set")) throw new InvalidDataException("Unsupported policy mapping type.");
                    if (!map.Anchor.IsEmpty) anchors[map.Anchor.Value] = mapping;
                    stack.Push(new(mapping)); break;
                case SequenceStart sequence:
                    var array = new PolicyYamlNode { List = [], Tag = sequence.Tag.IsEmpty ? "" : sequence.Tag.Value };
                    if (array.Tag is not ("" or "!" or "tag:yaml.org,2002:seq" or "tag:yaml.org,2002:omap" or "tag:yaml.org,2002:pairs")) throw new InvalidDataException("Unsupported policy sequence type.");
                    if (!sequence.Anchor.IsEmpty) anchors[sequence.Anchor.Value] = array;
                    stack.Push(new(array)); break;
                case MappingEnd or SequenceEnd:
                    if (stack.Count == 0) throw new InvalidDataException("Unbalanced YAML policy.");
                    var complete = stack.Pop();
                    if (complete.Key is not null) throw new InvalidDataException("Incomplete YAML policy mapping.");
                    ValidateTaggedContainer(complete.Value);
                    Attach(complete.Value); break;
                case Scalar scalar:
                    var item = new PolicyYamlNode { Scalar = new YamlScalarNode(scalar.Value) { Style = scalar.Style, Tag = scalar.Tag } };
                    // Validate types even in otherwise unused syntax, as the source YAML loader does.
                    _ = ScalarValue(item.Scalar);
                    if (!scalar.Anchor.IsEmpty) anchors[scalar.Anchor.Value] = item;
                    Attach(item); break;
                case AnchorAlias alias:
                    if (!anchors.TryGetValue(alias.Value.Value, out var borrowed)) throw new InvalidDataException("Unknown policy YAML anchor.");
                    Attach(borrowed); break;
            }
        }
        return documents == 1 && stack.Count == 0 && root is not null ? root : throw new InvalidDataException("Tool policy requires one YAML object document.");
    }
    private static void ValidateTaggedContainer(PolicyYamlNode node)
    {
        if (node.Tag == "tag:yaml.org,2002:set" && node.Map!.Values.Any(value => value.Scalar is null || ScalarValue(value.Scalar) is not null)) throw new InvalidDataException("YAML set values must be null.");
        if (node.Tag is not ("tag:yaml.org,2002:omap" or "tag:yaml.org,2002:pairs")) return;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in node.List!)
        {
            if (item.Map?.Count != 1) throw new InvalidDataException("Invalid ordered YAML pair collection.");
            var pair = item.Map.Single();
            if (node.Tag == "tag:yaml.org,2002:omap" && !seen.Add(pair.Key)) throw new InvalidDataException("Duplicate ordered YAML key.");
        }
        if (node.Tag == "tag:yaml.org,2002:pairs") node.List = node.List.Select(item => new PolicyYamlNode { List = [new() { Scalar = new(item.Map!.Single().Key) }, item.Map!.Single().Value] }).ToList();
    }
    private static bool MergeKey(PolicyYamlNode key) => key.Scalar is { Value: "<<" } scalar
        && (scalar.Tag.IsEmpty && scalar.Style is ScalarStyle.Plain or ScalarStyle.Any || !scalar.Tag.IsEmpty && scalar.Tag.Value == "tag:yaml.org,2002:merge");
    private static bool ObjectScalar(YamlScalarNode scalar) => ScalarValue(scalar) is UnsupportedScalar;
    private static IEnumerable<KeyValuePair<string, PolicyYamlNode>> ObjectEntries(PolicyYamlNode node)
    {
        if (node.Map is not null) return node.Map.ToArray();
        if (node.List is not null) return node.List.Select((value, index) => new KeyValuePair<string, PolicyYamlNode>(index.ToString(CultureInfo.InvariantCulture), value)).ToArray();
        if (ScalarValue(node.Scalar!) is UnsupportedScalar { Bytes: { } bytes }) return bytes.Select((value, index) => new KeyValuePair<string, PolicyYamlNode>(index.ToString(CultureInfo.InvariantCulture), new() { Scalar = new(value.ToString(CultureInfo.InvariantCulture)) })).ToArray();
        return [];
    }
    private static string Key(PolicyYamlNode node)
    {
        if (node.Map is not null) return "[object Object]";
        if (node.List is not null)
        {
            if (node.List.Any(item => item.List is not null)) throw new InvalidDataException("Nested arrays are not supported inside YAML keys.");
            return string.Join(',', node.List.Select(item => item.Scalar is not null && ScalarValue(item.Scalar) is null ? "" : Key(item)));
        }
        var value = ScalarValue(node.Scalar!);
        return value switch { null => "null", JsonValue json when json.TryGetValue<string>(out var text) => text,
            JsonNode json => EcmaJson.Stringify(json), NonfiniteScalar special => double.IsNaN(special.Value) ? "NaN" : special.Value < 0 ? "-Infinity" : "Infinity", UnsupportedScalar { Bytes: { } bytes } => string.Join(',', bytes),
            UnsupportedScalar date => DateKey(date.Raw), _ => throw new InvalidDataException("Unsupported YAML policy key.") };
    }
    internal sealed record NonfiniteScalar(double Value);
    internal sealed record UnsupportedScalar(string Raw, byte[]? Bytes = null);
    internal static object? ScalarValue(YamlScalarNode node)
    {
        var value = node.Value ?? ""; var tag = node.Tag.IsEmpty ? "" : node.Tag.Value;
        if (tag == "tag:yaml.org,2002:timestamp" || tag.Length == 0 && node.Style is ScalarStyle.Plain or ScalarStyle.Any && IsDate(value))
        { if (!IsDate(value)) throw new InvalidDataException("Invalid YAML timestamp."); return new UnsupportedScalar(value); }
        if (tag == "tag:yaml.org,2002:binary")
        {
            var clean = Regex.Replace(value, @"[\r\n ]", "");
            if (!Regex.IsMatch(clean, @"^[A-Za-z0-9+/]*={0,2}$", RegexOptions.CultureInvariant)) throw new InvalidDataException("Invalid YAML binary.");
            try { return new UnsupportedScalar(value, Convert.FromBase64String(clean)); } catch (FormatException) { throw new InvalidDataException("Invalid YAML binary."); }
        }
        return ToolAuthorizationYaml.Scalar(node);
    }
    private const string DatePattern = @"^([0-9]{4})-([0-9]{2})-([0-9]{2})$|^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?$";
    private static bool IsDate(string value) => Regex.IsMatch(value, DatePattern, RegexOptions.CultureInvariant);
    private static string DateKey(string raw)
    {
        var m = Regex.Match(raw, DatePattern, RegexOptions.CultureInvariant); var timed = m.Groups[4].Success;
        int Part(int index) => m.Groups[index].Success && m.Groups[index].Value.Length > 0 ? int.Parse(m.Groups[index].Value, CultureInfo.InvariantCulture) : 0;
        var year = Part(timed ? 4 : 1); if (year < 100) year += 1900;
        var shift = year > 9599 ? 400 : 0;
        var instant = new DateTimeOffset(year - shift, 1, 1, 0, 0, 0, TimeSpan.Zero).AddMonths(Part(timed ? 5 : 2) - 1).AddDays(Part(timed ? 6 : 3) - 1);
        if (timed)
        {
            var fraction = m.Groups[10].Value.PadRight(3, '0')[..3];
            instant = instant.AddHours(Part(7)).AddMinutes(Part(8)).AddSeconds(Part(9)).AddMilliseconds(int.Parse(fraction, CultureInfo.InvariantCulture));
            if (m.Groups[12].Success) instant = instant.AddMinutes((Part(13) * 60 + Part(14)) * (m.Groups[12].Value == "-" ? 1 : -1));
        }
        var local = TimeZoneInfo.ConvertTime(instant, TimeZoneInfo.Local); var zone = TimeZoneInfo.Local.IsDaylightSavingTime(local) ? TimeZoneInfo.Local.DaylightName : TimeZoneInfo.Local.StandardName;
        var offset = local.ToString("zzz", CultureInfo.InvariantCulture).Replace(":", "", StringComparison.Ordinal);
        return local.ToString("ddd MMM dd ", CultureInfo.InvariantCulture) + (local.Year + shift).ToString("D4", CultureInfo.InvariantCulture)
            + local.ToString(" HH:mm:ss", CultureInfo.InvariantCulture) + " GMT" + offset + " (" + zone + ")";
    }
}
