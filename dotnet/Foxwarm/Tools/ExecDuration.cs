using System.Globalization;

namespace Foxwarm.Tools;

internal static class ExecDuration
{
    internal static string? Format(double milliseconds)
    {
        if (!double.IsFinite(milliseconds) || milliseconds < 0)
            return null;
        if (milliseconds < 1000)
            return Math.Floor(milliseconds + 0.5).ToString(CultureInfo.InvariantCulture) + "ms";
        var tenths = Math.Floor(milliseconds / 100 + 0.5);
        var hours = Math.Floor(tenths / 36000);
        var minutes = Math.Floor(tenths % 36000 / 600);
        var seconds = tenths % 600 / 10;
        return (hours > 0 ? hours.ToString(CultureInfo.InvariantCulture) + "h " : "")
            + (minutes > 0 ? minutes.ToString(CultureInfo.InvariantCulture) + "m " : "")
            + seconds.ToString(CultureInfo.InvariantCulture) + "s";
    }

    internal static string Shell(string field) =>
        field.Length > 0 && field.All(c => c is >= '0' and <= '9')
        && long.TryParse(field, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
        && seconds <= 9007199254740991L
            ? seconds == 0 ? "<1s" : "~" + Format(seconds * 1000.0)
            : "unknown";
}
