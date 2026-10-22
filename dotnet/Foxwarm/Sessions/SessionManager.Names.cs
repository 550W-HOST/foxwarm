using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal Func<DateTimeOffset> SessionNameClock { get; set; } = () => DateTimeOffset.Now;
    internal Func<double> SessionNameRandom { get; set; } = Random.Shared.NextDouble;

    internal string GenerateSessionId()
    {
        var now = SessionNameClock();
        var random = SessionNameRandom();
        // Source uses Math.random().toString(36).substr(2, 5), not five independent
        // random characters. Keep its short exact fractions (including zero).
        var fraction = new StringBuilder(5);
        if (random > 0)
        {
            const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
            var delta = Math.Max(double.Epsilon, (Math.BitIncrement(random) - random) / 2);
            do
            {
                random *= 36;
                delta *= 36;
                var digit = (int)random;
                random -= digit;
                fraction.Append(digits[digit]);
                if ((random > 0.5 || random == 0.5 && (digit & 1) != 0) && random + delta > 1)
                {
                    for (var i = fraction.Length - 1; i >= 0; i--)
                    {
                        var next = digits.IndexOf(fraction[i]) + 1;
                        if (next < 36)
                        {
                            fraction[i] = digits[next];
                            break;
                        }
                        fraction.Length--;
                    }
                    break;
                }
            } while (random >= delta && fraction.Length < 5);
        }
        return now.ToString("MMdd", CultureInfo.InvariantCulture) + "_" + fraction;
    }

    private static void ValidateNewSessionName(string name)
    {
        if (!Regex.IsMatch(name, "\\A[a-zA-Z0-9_-]+\\z", RegexOptions.CultureInvariant))
            throw new InvalidDataException(
                "Invalid Session name: use only ASCII letters, digits, underscores, and hyphens."
            );
    }
}
