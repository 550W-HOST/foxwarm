using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Google.Protobuf;
using Monty.V1;

namespace Foxwarm.ToolScript;

/// <summary>Source-compatible JSON host values; protocol markers convey values, never tool authority.</summary>
internal static class MontyValues
{
    internal static MontyObject FromJson(JsonNode? node, ToolScriptDataBudget budget, int depth = 0)
    {
        if (depth > 97) throw new InvalidDataException("Monty input value exceeds its protocol depth.");
        budget.Charge(128);
        if (node is null) return new() { None = new Unit() };
        if (node is JsonArray array)
        {
            var list = new ObjectList(); foreach (var item in array) list.Items.Add(FromJson(item, budget, depth + 2));
            return new() { List = list };
        }
        if (node is JsonObject obj)
        {
            if (obj["__monty_type__"] is JsonValue marker && marker.TryGetValue<string>(out var type)) return Marker(obj, type, budget, depth);
            var map = new Dict();
            foreach (var (key, item) in OwnEntries(obj))
            { budget.Charge(64 + 8L * System.Text.Encoding.UTF8.GetByteCount(key)); map.Pairs.Add(new Pair { Key = new() { Str = key }, Value = FromJson(item, budget, depth + 3) }); }
            return new() { Dict = map };
        }
        var scalar = (JsonValue)node;
        if (scalar.TryGetValue<bool>(out var boolean)) return new() { Boolean = boolean };
        if (scalar.TryGetValue<string>(out var text)) { budget.Charge(8L * System.Text.Encoding.UTF8.GetByteCount(text)); return new() { Str = text }; }
        if (scalar.TryGetValue<long>(out var integer)) return new() { Int = integer };
        if (scalar.TryGetValue<int>(out var int32)) return new() { Int = int32 };
        if (scalar.TryGetValue<uint>(out var uint32)) return new() { Int = uint32 };
        if (scalar.TryGetValue<ulong>(out var uint64) && uint64 <= long.MaxValue) return new() { Int = (long)uint64 };
        if (scalar.TryGetValue<decimal>(out var decimalValue)) return new() { Float = (double)decimalValue };
        if (scalar.TryGetValue<float>(out var floatValue) && float.IsFinite(floatValue)) return new() { Float = floatValue };
        if (scalar.TryGetValue<double>(out var number) && double.IsFinite(number)) return new() { Float = number };
        throw new InvalidDataException("ToolScript host value is not a supported finite JSON value.");
    }
    internal static JsonNode? ToJson(MontyObject value, ToolScriptDataBudget budget, int depth = 0)
    {
        if (depth > 97) throw new InvalidDataException("Monty output value exceeds its protocol depth.");
        budget.Charge(96);
        switch (value.KindCase)
        {
            case MontyObject.KindOneofCase.None_: return null;
            case MontyObject.KindOneofCase.Boolean: return JsonValue.Create(value.Boolean);
            case MontyObject.KindOneofCase.Int:
                budget.Charge(128); return JsonValue.Create(JsonSerializer.SerializeToElement(value.Int));
            case MontyObject.KindOneofCase.Float:
                budget.Charge(128); return double.IsFinite(value.Float) ? JsonValue.Create(JsonSerializer.SerializeToElement(value.Float)) : null;
            case MontyObject.KindOneofCase.Str: return JsonValue.Create(value.Str);
            case MontyObject.KindOneofCase.Bytes:
                budget.Charge(checked(4L * value.Bytes.Length)); return JsonValue.Create(Convert.ToBase64String(value.Bytes.Span));
            case MontyObject.KindOneofCase.List: return List(value.List.Items, budget, depth);
            case MontyObject.KindOneofCase.Tuple: return List(value.Tuple.Items, budget, depth);
            case MontyObject.KindOneofCase.NamedTuple:
                if (value.NamedTuple.Values.Count != value.NamedTuple.FieldNames.Count) throw new InvalidDataException("Invalid Monty named tuple.");
                return List(value.NamedTuple.Values, budget, depth);
            case MontyObject.KindOneofCase.Set: return List(value.Set.Items, budget, depth);
            case MontyObject.KindOneofCase.FrozenSet: return List(value.FrozenSet.Items, budget, depth);
            case MontyObject.KindOneofCase.Dict:
                var map = new JsonObject();
                foreach (var pair in value.Dict.Pairs)
                { var key = Key(ToJson(pair.Key, budget, depth + 3)); map[key] = ToJson(pair.Value, budget, depth + 3); }
                return map;
            case MontyObject.KindOneofCase.Date:
                ValidateDate(value.Date.Year, value.Date.Month, value.Date.Day);
                return new JsonObject { ["__monty_type__"] = "Date", ["year"] = value.Date.Year, ["month"] = value.Date.Month, ["day"] = value.Date.Day };
            case MontyObject.KindOneofCase.Datetime:
                var time = value.Datetime; ValidateDate(time.Year, time.Month, time.Day);
                if (time.Hour > 23 || time.Minute > 59 || time.Second > 59 || time.Microsecond > 999999 || time.HasOffsetSeconds && Math.Abs((long)time.OffsetSeconds) >= 86400) throw new InvalidDataException("Invalid Monty datetime.");
                var date = new JsonObject { ["__monty_type__"] = "DateTime", ["year"] = time.Year, ["month"] = time.Month, ["day"] = time.Day, ["hour"] = time.Hour, ["minute"] = time.Minute, ["second"] = time.Second, ["microsecond"] = time.Microsecond };
                if (time.HasOffsetSeconds) date["offsetSeconds"] = time.OffsetSeconds;
                if (time.HasTimezoneName) { if (!time.HasOffsetSeconds) throw new InvalidDataException("Monty timezone name requires an offset."); date["timezoneName"] = time.TimezoneName; }
                return date;
            case MontyObject.KindOneofCase.Timedelta:
                var delta = value.Timedelta;
                if (delta.Seconds is < 0 or >= 86400 || delta.Microseconds is < 0 or >= 1000000) throw new InvalidDataException("Invalid Monty timedelta.");
                return new JsonObject { ["__monty_type__"] = "TimeDelta", ["days"] = delta.Days, ["seconds"] = delta.Seconds, ["microseconds"] = delta.Microseconds };
            case MontyObject.KindOneofCase.Timezone:
                if (Math.Abs((long)value.Timezone.OffsetSeconds) >= 86400) throw new InvalidDataException("Invalid Monty timezone.");
                var zone = new JsonObject { ["__monty_type__"] = "TimeZone", ["offsetSeconds"] = value.Timezone.OffsetSeconds };
                if (value.Timezone.HasName) zone["name"] = value.Timezone.Name; return zone;
            case MontyObject.KindOneofCase.Exception:
                return new JsonObject { ["__monty_type__"] = "Exception", ["excType"] = value.Exception.ExcType, ["message"] = value.Exception.HasArg ? value.Exception.Arg : "" };
            case MontyObject.KindOneofCase.Type: return new JsonObject { ["__monty_type__"] = "Type", ["value"] = value.Type };
            case MontyObject.KindOneofCase.BuiltinFunction: return new JsonObject { ["__monty_type__"] = "BuiltinFunction", ["value"] = value.BuiltinFunction };
            case MontyObject.KindOneofCase.Ellipsis: return new JsonObject { ["__monty_type__"] = "Ellipsis" };
            case MontyObject.KindOneofCase.Path: return JsonValue.Create(value.Path);
            case MontyObject.KindOneofCase.Function: return JsonValue.Create(value.Function.Name);
            case MontyObject.KindOneofCase.Repr: return JsonValue.Create(value.Repr);
            case MontyObject.KindOneofCase.Cycle: return JsonValue.Create(value.Cycle.Placeholder);
            case MontyObject.KindOneofCase.InstanceType: return new JsonObject { ["__monty_type__"] = "InstanceType", ["value"] = value.InstanceType };
            case MontyObject.KindOneofCase.Bigint: case MontyObject.KindOneofCase.Dataclass:
                // Source's normalized JS BigInt (also dataclass typeId) cannot be persisted by its JSON writer.
                throw new InvalidDataException("ToolScript result contains a non-JSON integer or dataclass identity. Return a JSON-compatible projection.");
            default: throw new InvalidDataException("Unsupported or missing Monty value kind: " + value.KindCase);
        }
    }
    private static JsonArray List(IEnumerable<MontyObject> items, ToolScriptDataBudget budget, int depth)
    { var output = new JsonArray(); foreach (var item in items) output.Add(ToJson(item, budget, depth + 2)); return output; }
    private static IEnumerable<KeyValuePair<string, JsonNode?>> OwnEntries(JsonObject value) => value
        .OrderBy(pair => ArrayIndex(pair.Key).HasValue ? 0 : 1).ThenBy(pair => ArrayIndex(pair.Key) ?? 0);
    private static uint? ArrayIndex(string key) => uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
        && value != uint.MaxValue && value.ToString(CultureInfo.InvariantCulture) == key ? value : null;
    private static string Key(JsonNode? node) => node switch
    {
        null => "null", JsonArray array => string.Join(',', array.Select(item => item is null ? "" : Key(item))),
        JsonObject => "[object Object]", JsonValue value when value.TryGetValue<string>(out var text) => text,
        _ => node.ToJsonString()
    };
    private static void ValidateDate(int year, uint month, uint day)
    { try { _ = new System.DateTime(year, checked((int)month), checked((int)day)); } catch (ArgumentOutOfRangeException error) { throw new InvalidDataException("Invalid Monty date.", error); } }
    private static MontyObject Marker(JsonObject obj, string type, ToolScriptDataBudget budget, int depth)
    {
        int Int(string key) => obj[key]?.GetValue<int>() ?? throw new InvalidDataException("Monty " + type + " requires " + key + ".");
        string Text(string key) => obj[key]?.GetValue<string>() ?? throw new InvalidDataException("Monty " + type + " requires " + key + ".");
        switch (type)
        {
            case "Ellipsis": return new() { Ellipsis = new Unit() };
            case "Type": return new() { Type = Text("value") };
            case "BuiltinFunction": return new() { BuiltinFunction = Text("value") };
            case "Exception": return new() { Exception = new Monty.V1.Exception { ExcType = Text("excType"), Arg = obj["message"]?.GetValue<string>() ?? "" } };
            case "Date":
                var year = Int("year"); var month = checked((uint)Int("month")); var day = checked((uint)Int("day")); ValidateDate(year, month, day);
                return new() { Date = new Date { Year = year, Month = month, Day = day } };
            case "DateTime":
                var date = new Monty.V1.DateTime { Year = Int("year"), Month = checked((uint)Int("month")), Day = checked((uint)Int("day")), Hour = checked((uint)Int("hour")), Minute = checked((uint)Int("minute")), Second = checked((uint)Int("second")), Microsecond = checked((uint)Int("microsecond")) };
                if (obj["offsetSeconds"] is not null) date.OffsetSeconds = Int("offsetSeconds");
                if (obj["timezoneName"] is not null) date.TimezoneName = Text("timezoneName");
                _ = ToJson(new MontyObject { Datetime = date }, budget, depth); return new() { Datetime = date };
            case "TimeDelta":
                var delta = new TimeDelta { Days = Int("days"), Seconds = Int("seconds"), Microseconds = Int("microseconds") };
                _ = ToJson(new MontyObject { Timedelta = delta }, budget, depth); return new() { Timedelta = delta };
            case "TimeZone":
                var zone = new Monty.V1.TimeZone { OffsetSeconds = Int("offsetSeconds") }; if (obj["name"] is not null) zone.Name = Text("name");
                _ = ToJson(new MontyObject { Timezone = zone }, budget, depth); return new() { Timezone = zone };
            default: throw new InvalidDataException("Unsupported Monty value marker: " + type);
        }
    }
}
