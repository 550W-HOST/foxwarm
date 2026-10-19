using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm;

internal static class CommandArguments
{
    internal static int? Integer(string? text)
    {
        var match = Regex.Match(text ?? "", @"^[+-]?\d+");
        return match.Success && int.TryParse(match.Value, out var value) ? value : null;
    }

    internal static double? Number(string? text)
    {
        var match = Regex.Match(text ?? "", @"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?");
        return
            match.Success
            && double.TryParse(match.Value, CultureInfo.InvariantCulture, out var value)
            && double.IsFinite(value)
            ? value
            : null;
    }

    internal static double? CompactKeep(string[] args)
    {
        if (args.FirstOrDefault() == "tools")
            throw new InvalidDataException(
                "Historical tool-response pruning is not available through this command yet."
            );
        return Number(args.FirstOrDefault()) is > 0 and <= 100 and var value ? value / 100 : null;
    }

    internal static (string[] Remaining, bool Present, string? Effort) Effort(string[] tokens)
    {
        var remaining = new List<string>();
        var present = false;
        string? effort = null;
        for (var index = 0; index < tokens.Length; index++)
        {
            if (tokens[index] != "--effort")
            {
                remaining.Add(tokens[index]);
                continue;
            }
            if (present)
                throw new InvalidDataException("--effort may be specified only once.");
            present = true;
            var raw = tokens.ElementAtOrDefault(++index)?.Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(raw))
                throw new InvalidDataException("--effort requires a value.");
            effort =
                raw is "default" or "unset" ? null
                : HostModels.Efforts.Contains(raw) ? raw
                : throw new InvalidDataException(
                    "Effort must be one of: "
                        + string.Join(", ", HostModels.Efforts)
                        + ", default, or unset."
                );
        }
        return (remaining.ToArray(), present, effort);
    }

    internal sealed record CreateFlags(string? Model, string? Effort, string[] Files);

    internal static CreateFlags SessionCreate(string[] tokens)
    {
        string? model = null,
            effort = null;
        var files = new List<string>();
        for (var index = 0; index < tokens.Length; index++)
        {
            var flag = tokens[index];
            if (flag is not ("--model" or "--effort" or "--system-prompt-file"))
                throw new InvalidDataException("Unknown /session create argument: " + flag);
            if (flag == "--model" && model is not null || flag == "--effort" && effort is not null)
                throw new InvalidDataException(flag + " may be specified only once.");
            var value = tokens.ElementAtOrDefault(++index);
            if (string.IsNullOrEmpty(value) || value.StartsWith("--", StringComparison.Ordinal))
                throw new InvalidDataException(flag + " requires a value.");
            if (flag == "--model")
                model = value;
            else if (flag == "--effort")
            {
                effort = value.Trim().ToLowerInvariant();
                if (!HostModels.Efforts.Contains(effort))
                    throw new InvalidDataException(
                        "--effort must be one of: " + string.Join(", ", HostModels.Efforts) + "."
                    );
            }
            else
                files.Add(value);
        }
        return new(model, effort, files.ToArray());
    }

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
