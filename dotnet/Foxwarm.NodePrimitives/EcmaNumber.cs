using System.Globalization;

namespace Foxwarm;

internal static class EcmaNumber
{
    public static string Format(double value)
    {
        if (!double.IsFinite(value))
            throw new InvalidDataException("ECMAScript JSON numbers must be finite.");
        if (value == 0)
            return "0";
        var negative = value < 0;
        var shortest = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponentMarker = shortest.IndexOfAny(['E', 'e']);
        var significand = exponentMarker < 0 ? shortest : shortest[..exponentMarker];
        var explicitExponent =
            exponentMarker < 0
                ? 0
                : int.Parse(
                    shortest[(exponentMarker + 1)..],
                    NumberStyles.AllowLeadingSign,
                    CultureInfo.InvariantCulture
                );
        var dot = significand.IndexOf('.');
        var decimalPoint = (dot < 0 ? significand.Length : dot) + explicitExponent;
        var digits = dot < 0 ? significand : significand.Remove(dot, 1);
        while (digits.Length > 1 && digits[0] == '0')
        {
            digits = digits[1..];
            decimalPoint--;
        }
        var scientificExponent = decimalPoint - 1;
        string rendered;
        if (scientificExponent >= -6 && scientificExponent < 21)
        {
            rendered = decimalPoint switch
            {
                <= 0 => "0." + new string('0', -decimalPoint) + digits,
                _ when decimalPoint >= digits.Length => digits
                    + new string('0', decimalPoint - digits.Length),
                _ => digits.Insert(decimalPoint, "."),
            };
        }
        else
        {
            rendered = digits.Length == 1 ? digits : digits[0] + "." + digits[1..];
            rendered +=
                scientificExponent >= 0
                    ? $"e+{scientificExponent.ToString(CultureInfo.InvariantCulture)}"
                    : $"e{scientificExponent.ToString(CultureInfo.InvariantCulture)}";
        }
        return negative ? "-" + rendered : rendered;
    }
}
