using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Google.Protobuf;
using Monty.V1;

namespace Foxwarm.ToolScript;

/// <summary>Source-compatible JSON host values; protocol markers convey values, never tool authority.</summary>
internal static class MontyValues
{
    /// <summary>Builds one node arena for a host value; every node follows its children.</summary>
    internal sealed class Builder
    {
        private readonly Arena arena = new();

        internal uint Add(MontyNode node)
        {
            arena.Nodes.Add(node);
            return checked((uint)(arena.Nodes.Count - 1));
        }

        internal Arena Build()
        {
            arena.NodeCount = checked((uint)arena.Nodes.Count);
            return arena;
        }
    }

    internal static (Arena Values, uint Root) FromJson(JsonNode? node, ToolScriptDataBudget budget)
    {
        var builder = new Builder();
        var root = FromJson(builder, node, budget);
        return (builder.Build(), root);
    }

    internal static uint FromJson(
        Builder builder,
        JsonNode? node,
        ToolScriptDataBudget budget,
        int depth = 0
    )
    {
        if (depth > 97)
            throw new InvalidDataException("Monty input value exceeds its protocol depth.");
        budget.Charge(128);
        if (node is null)
            return builder.Add(new() { None = new Unit() });
        if (node is JsonArray array)
        {
            var list = new Indexes();
            foreach (var item in array)
                list.Items.Add(FromJson(builder, item, budget, depth + 2));
            return builder.Add(new() { List = list });
        }
        if (node is JsonObject obj)
        {
            if (
                obj["__monty_type__"] is JsonValue marker
                && marker.TryGetValue<string>(out var type)
            )
                return Marker(builder, obj, type, budget, depth);
            var map = new NodePairs();
            foreach (var (key, item) in OwnEntries(obj))
            {
                budget.Charge(64 + 8L * System.Text.Encoding.UTF8.GetByteCount(key));
                var keyIndex = builder.Add(new() { Str = key });
                map.Pairs.Add(
                    new NodePair
                    {
                        Key = keyIndex,
                        Value = FromJson(builder, item, budget, depth + 3),
                    }
                );
            }
            return builder.Add(new() { Dict = map });
        }
        var scalar = (JsonValue)node;
        if (scalar.TryGetValue<bool>(out var boolean))
            return builder.Add(new() { Boolean = boolean });
        if (scalar.TryGetValue<string>(out var text))
        {
            budget.Charge(8L * System.Text.Encoding.UTF8.GetByteCount(text));
            return builder.Add(new() { Str = text });
        }
        if (scalar.TryGetValue<long>(out var integer))
            return builder.Add(new() { Int = integer });
        if (scalar.TryGetValue<int>(out var int32))
            return builder.Add(new() { Int = int32 });
        if (scalar.TryGetValue<uint>(out var uint32))
            return builder.Add(new() { Int = uint32 });
        if (scalar.TryGetValue<ulong>(out var uint64) && uint64 <= long.MaxValue)
            return builder.Add(new() { Int = (long)uint64 });
        if (scalar.TryGetValue<float>(out var floatValue) && float.IsFinite(floatValue))
            return builder.Add(new() { Float = floatValue });
        if (scalar.TryGetValue<double>(out var number) && double.IsFinite(number))
            return builder.Add(new() { Float = number });
        throw new InvalidDataException(
            "ToolScript host value is not a supported finite JSON value."
        );
    }

    internal static JsonNode? ToJson(
        Arena arena,
        uint index,
        ToolScriptDataBudget budget,
        int depth = 0
    ) => ToJson(arena, index, uint.MaxValue, budget, depth);

    /// <summary>Converts one arena node; a child must precede the node that holds it.</summary>
    private static JsonNode? ToJson(
        Arena arena,
        uint index,
        uint holder,
        ToolScriptDataBudget budget,
        int depth
    )
    {
        if (depth > 97)
            throw new InvalidDataException("Monty output value exceeds its protocol depth.");
        if (index >= arena.Nodes.Count || holder != uint.MaxValue && index >= holder)
            throw new InvalidDataException("Monty value node index is outside its arena.");
        var value = arena.Nodes[(int)index];
        budget.Charge(96);
        switch (value.KindCase)
        {
            case MontyNode.KindOneofCase.None_:
                return null;
            case MontyNode.KindOneofCase.Boolean:
                return JsonValue.Create(value.Boolean);
            case MontyNode.KindOneofCase.Int:
                budget.Charge(128);
                return JsonValue.Create(JsonData.SerializeToElement(value.Int));
            case MontyNode.KindOneofCase.Float:
                budget.Charge(128);
                return double.IsFinite(value.Float)
                    ? JsonValue.Create(JsonData.SerializeToElement(value.Float))
                    : null;
            case MontyNode.KindOneofCase.Str:
                return JsonValue.Create(value.Str);
            case MontyNode.KindOneofCase.Bytes:
                budget.Charge(checked(4L * value.Bytes.Length));
                return JsonValue.Create(Convert.ToBase64String(value.Bytes.Span));
            case MontyNode.KindOneofCase.List:
                return List(arena, value.List.Items, index, budget, depth);
            case MontyNode.KindOneofCase.Tuple:
                return List(arena, value.Tuple.Items, index, budget, depth);
            case MontyNode.KindOneofCase.NamedTuple:
                if (value.NamedTuple.Values.Count != value.NamedTuple.FieldNames.Count)
                    throw new InvalidDataException("Invalid Monty named tuple.");
                return List(arena, value.NamedTuple.Values, index, budget, depth);
            case MontyNode.KindOneofCase.Set:
                return List(arena, value.Set.Items, index, budget, depth);
            case MontyNode.KindOneofCase.FrozenSet:
                return List(arena, value.FrozenSet.Items, index, budget, depth);
            case MontyNode.KindOneofCase.Dict:
                var map = new JsonObject();
                foreach (var pair in value.Dict.Pairs)
                {
                    var key = Key(ToJson(arena, pair.Key, index, budget, depth + 3));
                    map[key] = ToJson(arena, pair.Value, index, budget, depth + 3);
                }
                return map;
            case MontyNode.KindOneofCase.Date:
                ValidateDate(value.Date.Year, value.Date.Month, value.Date.Day);
                return new JsonObject
                {
                    ["__monty_type__"] = "Date",
                    ["year"] = value.Date.Year,
                    ["month"] = value.Date.Month,
                    ["day"] = value.Date.Day,
                };
            case MontyNode.KindOneofCase.Datetime:
                var time = value.Datetime;
                ValidateDate(time.Year, time.Month, time.Day);
                if (
                    time.Hour > 23
                    || time.Minute > 59
                    || time.Second > 59
                    || time.Microsecond > 999999
                    || time.HasOffsetSeconds && Math.Abs((long)time.OffsetSeconds) >= 86400
                )
                    throw new InvalidDataException("Invalid Monty datetime.");
                var date = new JsonObject
                {
                    ["__monty_type__"] = "DateTime",
                    ["year"] = time.Year,
                    ["month"] = time.Month,
                    ["day"] = time.Day,
                    ["hour"] = time.Hour,
                    ["minute"] = time.Minute,
                    ["second"] = time.Second,
                    ["microsecond"] = time.Microsecond,
                };
                if (time.HasOffsetSeconds)
                    date["offsetSeconds"] = time.OffsetSeconds;
                if (time.HasTimezoneName)
                {
                    if (!time.HasOffsetSeconds)
                        throw new InvalidDataException("Monty timezone name requires an offset.");
                    date["timezoneName"] = time.TimezoneName;
                }
                return date;
            case MontyNode.KindOneofCase.Timedelta:
                var delta = value.Timedelta;
                if (delta.Seconds is < 0 or >= 86400 || delta.Microseconds is < 0 or >= 1000000)
                    throw new InvalidDataException("Invalid Monty timedelta.");
                return new JsonObject
                {
                    ["__monty_type__"] = "TimeDelta",
                    ["days"] = delta.Days,
                    ["seconds"] = delta.Seconds,
                    ["microseconds"] = delta.Microseconds,
                };
            case MontyNode.KindOneofCase.Timezone:
                if (Math.Abs((long)value.Timezone.OffsetSeconds) >= 86400)
                    throw new InvalidDataException("Invalid Monty timezone.");
                var zone = new JsonObject
                {
                    ["__monty_type__"] = "TimeZone",
                    ["offsetSeconds"] = value.Timezone.OffsetSeconds,
                };
                if (value.Timezone.HasName)
                    zone["name"] = value.Timezone.Name;
                return zone;
            case MontyNode.KindOneofCase.Exception:
                return new JsonObject
                {
                    ["__monty_type__"] = "Exception",
                    ["excType"] = value.Exception.ExcType,
                    ["message"] = value.Exception.HasArg ? value.Exception.Arg : "",
                };
            case MontyNode.KindOneofCase.Type:
                // A sandbox-defined class is the repr string the earlier worker returned for it, so it
                // cannot be mistaken for a builtin type marker.
                return value.Type.Origin switch
                {
                    TypeOrigin.Builtin => new JsonObject
                    {
                        ["__monty_type__"] = "Type",
                        ["value"] = value.Type.Name,
                    },
                    TypeOrigin.Sandbox => JsonValue.Create("<class '" + value.Type.Name + "'>"),
                    _ => throw new InvalidDataException(
                        "ToolScript result contains a host class, which has no JSON form."
                    ),
                };
            case MontyNode.KindOneofCase.BuiltinFunction:
                return new JsonObject
                {
                    ["__monty_type__"] = "BuiltinFunction",
                    ["value"] = value.BuiltinFunction,
                };
            case MontyNode.KindOneofCase.Ellipsis:
                return new JsonObject { ["__monty_type__"] = "Ellipsis" };
            case MontyNode.KindOneofCase.Path:
                return JsonValue.Create(value.Path);
            case MontyNode.KindOneofCase.Function:
                return JsonValue.Create(value.Function.Name);
            case MontyNode.KindOneofCase.Repr:
                return JsonValue.Create(value.Repr);
            case MontyNode.KindOneofCase.Cycle:
                return JsonValue.Create(value.Cycle);
            case MontyNode.KindOneofCase.Bigint:
            case MontyNode.KindOneofCase.ClassInstance:
                // Source's normalized JS BigInt (also a class instance's identity) cannot be persisted by its JSON writer.
                throw new InvalidDataException(
                    "ToolScript result contains a non-JSON integer or class instance. Return a JSON-compatible projection."
                );
            default:
                throw new InvalidDataException(
                    "Unsupported or missing Monty value kind: " + value.KindCase
                );
        }
    }

    private static JsonArray List(
        Arena arena,
        IEnumerable<uint> items,
        uint holder,
        ToolScriptDataBudget budget,
        int depth
    )
    {
        var output = new JsonArray();
        foreach (var item in items)
            output.Add(ToJson(arena, item, holder, budget, depth + 2));
        return output;
    }

    private static IEnumerable<KeyValuePair<string, JsonNode?>> OwnEntries(JsonObject value) =>
        value
            .OrderBy(pair => ArrayIndex(pair.Key).HasValue ? 0 : 1)
            .ThenBy(pair => ArrayIndex(pair.Key) ?? 0);

    private static uint? ArrayIndex(string key) =>
        uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
        && value != uint.MaxValue
        && value.ToString(CultureInfo.InvariantCulture) == key
            ? value
            : null;

    private static string Key(JsonNode? node) =>
        node switch
        {
            null => "null",
            JsonArray array => string.Join(
                ',',
                array.Select(item => item is null ? "" : Key(item))
            ),
            JsonObject => "[object Object]",
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            _ => node.ToJsonText(),
        };

    private static void ValidateDate(int year, uint month, uint day)
    {
        try
        {
            _ = new System.DateTime(year, checked((int)month), checked((int)day));
        }
        catch (ArgumentOutOfRangeException error)
        {
            throw new InvalidDataException("Invalid Monty date.", error);
        }
    }

    private static uint Marker(
        Builder builder,
        JsonObject obj,
        string type,
        ToolScriptDataBudget budget,
        int depth
    )
    {
        int Int(string key) =>
            obj[key]?.GetValue<int>()
            ?? throw new InvalidDataException("Monty " + type + " requires " + key + ".");
        string Text(string key) =>
            obj[key]?.GetValue<string>()
            ?? throw new InvalidDataException("Monty " + type + " requires " + key + ".");
        // Validates a built value through the output conversion, in a scratch arena.
        void Validate(MontyNode node)
        {
            var scratch = new Arena();
            scratch.Nodes.Add(node);
            _ = ToJson(scratch, 0, budget, depth);
        }
        switch (type)
        {
            case "Ellipsis":
                return builder.Add(new() { Ellipsis = new Unit() });
            case "Type":
                return builder.Add(
                    new()
                    {
                        Type = new Monty.V1.Type
                        {
                            Name = Text("value"),
                            Origin = TypeOrigin.Builtin,
                        },
                    }
                );
            case "BuiltinFunction":
                return builder.Add(new() { BuiltinFunction = Text("value") });
            case "Exception":
                return builder.Add(
                    new()
                    {
                        Exception = new Monty.V1.Exception
                        {
                            ExcType = Text("excType"),
                            Arg = obj["message"]?.GetValue<string>() ?? "",
                        },
                    }
                );
            case "Date":
                var year = Int("year");
                var month = checked((uint)Int("month"));
                var day = checked((uint)Int("day"));
                ValidateDate(year, month, day);
                return builder.Add(
                    new()
                    {
                        Date = new Date
                        {
                            Year = year,
                            Month = month,
                            Day = day,
                        },
                    }
                );
            case "DateTime":
                var date = new Monty.V1.DateTime
                {
                    Year = Int("year"),
                    Month = checked((uint)Int("month")),
                    Day = checked((uint)Int("day")),
                    Hour = checked((uint)Int("hour")),
                    Minute = checked((uint)Int("minute")),
                    Second = checked((uint)Int("second")),
                    Microsecond = checked((uint)Int("microsecond")),
                };
                if (obj["offsetSeconds"] is not null)
                    date.OffsetSeconds = Int("offsetSeconds");
                if (obj["timezoneName"] is not null)
                    date.TimezoneName = Text("timezoneName");
                Validate(new() { Datetime = date });
                return builder.Add(new() { Datetime = date });
            case "TimeDelta":
                var delta = new TimeDelta
                {
                    Days = Int("days"),
                    Seconds = Int("seconds"),
                    Microseconds = Int("microseconds"),
                };
                Validate(new() { Timedelta = delta });
                return builder.Add(new() { Timedelta = delta });
            case "TimeZone":
                var zone = new Monty.V1.TimeZone { OffsetSeconds = Int("offsetSeconds") };
                if (obj["name"] is not null)
                    zone.Name = Text("name");
                Validate(new() { Timezone = zone });
                return builder.Add(new() { Timezone = zone });
            default:
                throw new InvalidDataException("Unsupported Monty value marker: " + type);
        }
    }
}
