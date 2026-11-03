using System.Globalization;
using System.Text;

namespace Foxwarm.Sessions;

/// <summary>
/// Prepared first-run welcome for the main Agent's default Session. The text is a
/// packaged resource, chosen by client language with an English fallback.
/// </summary>
internal static class FirstRunWelcome
{
    internal const string English = "en";
    internal const string Chinese = "zh";

    /// <summary>
    /// Chooses the welcome language. An explicit client locale wins; otherwise the
    /// Accept-Language preference with the highest weight among the available
    /// languages is used. Anything else falls back to English.
    /// </summary>
    internal static string Language(string? locale, string? acceptLanguage)
    {
        if (!string.IsNullOrWhiteSpace(locale))
            return Supported(locale) ?? English;
        string? best = null;
        var bestWeight = 0d;
        foreach (var entry in (acceptLanguage ?? "").Split(','))
        {
            var fields = entry.Split(';');
            var tag = fields[0].Trim();
            var weight = 1d;
            foreach (var parameter in fields.Skip(1))
            {
                var pair = parameter.Split('=', 2);
                if (
                    pair.Length == 2
                    && pair[0].Trim() == "q"
                    && double.TryParse(
                        pair[1].Trim(),
                        NumberStyles.Float,
                        CultureInfo.InvariantCulture,
                        out var parsed
                    )
                )
                    weight = parsed;
            }
            if (Supported(tag) is not { } language || weight <= bestWeight)
                continue;
            best = language;
            bestWeight = weight;
        }
        return best ?? English;
    }

    private static string? Supported(string tag)
    {
        var primary = tag.Trim().Split('-', '_')[0].ToLowerInvariant();
        return primary switch
        {
            "zh" => Chinese,
            "en" => English,
            _ => null,
        };
    }

    internal static async Task<string> TextAsync(string resourceRoot, string language)
    {
        var path = Path.Combine(
            resourceRoot,
            "templates",
            "main",
            "welcome",
            (language == Chinese ? Chinese : English) + ".md"
        );
        return (await File.ReadAllTextAsync(path, Encoding.UTF8)).Trim();
    }
}
