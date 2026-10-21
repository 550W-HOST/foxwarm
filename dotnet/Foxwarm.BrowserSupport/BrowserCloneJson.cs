using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Foxwarm.BrowserSupport;

// Stringify the return-by-value clone in the host, never in the page's mutable realm.
internal static class BrowserCloneJson
{
    internal static string Stringify(JsonElement clone)
    {
        var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(clone.GetRawText()));
        reader.Read();
        var output = new StringBuilder();
        Append(ref reader, output);
        return output.ToString();
    }

    private static void Append(ref Utf8JsonReader reader, StringBuilder output)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.StartObject:
                output.Append('{');
                var firstProperty = true;
                // CDP's clone already enumerated the object's JS property order.
                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                {
                    if (!firstProperty)
                        output.Append(',');
                    firstProperty = false;
                    AppendString(ref reader, output);
                    output.Append(':');
                    reader.Read();
                    Append(ref reader, output);
                }
                output.Append('}');
                break;
            case JsonTokenType.StartArray:
                output.Append('[');
                var firstItem = true;
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    if (!firstItem)
                        output.Append(',');
                    firstItem = false;
                    Append(ref reader, output);
                }
                output.Append(']');
                break;
            case JsonTokenType.String:
                AppendString(ref reader, output);
                break;
            case JsonTokenType.Number:
                var number = reader.GetDouble();
                output.Append(double.IsFinite(number) ? EcmaNumber.Format(number) : "null");
                break;
            case JsonTokenType.True:
                output.Append("true");
                break;
            case JsonTokenType.False:
                output.Append("false");
                break;
            case JsonTokenType.Null:
                output.Append("null");
                break;
        }
    }

    private static void AppendString(ref Utf8JsonReader reader, StringBuilder output)
    {
        var token = Encoding.UTF8.GetString(reader.ValueSpan);
        if (!reader.ValueIsEscaped)
        {
            JsonStringQuoting.Append(output, token);
            return;
        }
        // Decode only an already parsed JSON string token. GetString would reject
        // lone UTF-16 units that CDP and JavaScript preserve in values and keys.
        var decoded = new StringBuilder(token.Length);
        for (var index = 0; index < token.Length; index++)
        {
            if (token[index] != '\\')
            {
                decoded.Append(token[index]);
                continue;
            }
            var escape = token[++index];
            if (escape == 'u')
            {
                decoded.Append(
                    (char)
                        ushort.Parse(
                            token.AsSpan(index + 1, 4),
                            NumberStyles.AllowHexSpecifier,
                            CultureInfo.InvariantCulture
                        )
                );
                index += 4;
            }
            else
                decoded.Append(
                    escape switch
                    {
                        'b' => '\b',
                        'f' => '\f',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        _ => escape,
                    }
                );
        }
        JsonStringQuoting.Append(output, decoded.ToString());
    }
}
