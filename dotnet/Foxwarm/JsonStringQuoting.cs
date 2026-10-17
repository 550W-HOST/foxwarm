using System.Globalization;
using System.Text;

namespace Foxwarm;

// JSON.stringify string quoting shared by journal identity and download capability bytes.
internal static class JsonStringQuoting
{
    internal static void Append(StringBuilder builder, string value)
    {
        builder.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];
            if (ch == '"')
                builder.Append("\\\"");
            else if (ch == '\\')
                builder.Append("\\\\");
            else if (ch == '\b')
                builder.Append("\\b");
            else if (ch == '\f')
                builder.Append("\\f");
            else if (ch == '\n')
                builder.Append("\\n");
            else if (ch == '\r')
                builder.Append("\\r");
            else if (ch == '\t')
                builder.Append("\\t");
            else if (ch < 0x20)
                builder
                    .Append("\\u")
                    .Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
            else if (
                char.IsHighSurrogate(ch)
                && i + 1 < value.Length
                && char.IsLowSurrogate(value[i + 1])
            )
            {
                builder.Append(ch).Append(value[++i]);
            }
            else if (char.IsSurrogate(ch))
                builder
                    .Append("\\u")
                    .Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
            else
                builder.Append(ch);
        }
        builder.Append('"');
    }
}
