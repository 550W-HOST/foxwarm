using Foxwarm.Models;

namespace Foxwarm;

internal static class CommandArguments
{
    internal static string ResolveModel(string input, HostModels models)
    {
        input = input.Trim();
        models = models.Capture();
        if (models.Contains(input))
            return input;
        var matches = models
            .Options.Select(model => model.Key)
            .Where(key => key.Contains(input, StringComparison.OrdinalIgnoreCase))
            .ToArray();
        if (matches.Length == 1)
            return matches[0];
        throw new InvalidDataException(
            matches.Length == 0
                ? $"❌ No models matching `{input}`. Use /model to list available models."
                : $"❌ Multiple models match `{input}`:\n\n"
                    + string.Join("\n", matches.Select(key => "- `" + key + "`"))
                    + "\n\nPlease be more specific."
        );
    }
}
