using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Installation-wide enrollment policy. Null labels mean all labels; an empty list means none.
internal sealed record TextRedactionKnownLabels
{
    internal static TextRedactionKnownLabels Default { get; } =
        new(["private_address", "private_email", "private_phone"]);

    internal static TextRedactionKnownLabels All { get; } = new((IReadOnlyList<string>?)null);

    internal IReadOnlyList<string>? Labels { get; }

    private TextRedactionKnownLabels(IReadOnlyList<string>? labels) => Labels = labels;

    internal bool Allows(IEnumerable<string> labels) =>
        Labels is null
        || labels.Any(label =>
            Labels.Contains(TextRedactionOptions.NormalizeLabel(label), StringComparer.Ordinal)
        );

    internal static TextRedactionKnownLabels Parse(JsonNode? value)
    {
        if (SessionWait.Text(value) == "all")
            return All;
        if (
            value is not JsonArray labels
            || labels.Any(label =>
                SessionWait.Text(label) is not string text || text.Trim().Length == 0
            )
        )
            throw new InvalidDataException(
                "textRedaction.knownLabels must be a list of labels or \"all\"."
            );
        return new(
            labels
                .Select(label => TextRedactionOptions.NormalizeLabel(SessionWait.Text(label)!))
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray()
        );
    }

    internal static TextRedactionKnownLabels FromDefaults(JsonObject? defaults) =>
        defaults?["textRedaction"] is JsonObject options && options.ContainsKey("knownLabels")
            ? Parse(options["knownLabels"])
            : Default;

    public bool Equals(TextRedactionKnownLabels? other) =>
        other is not null
        && (
            Labels is null
                ? other.Labels is null
                : other.Labels is not null
                    && Labels.SequenceEqual(other.Labels, StringComparer.Ordinal)
        );

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(Labels is null);
        if (Labels is not null)
            foreach (var label in Labels)
                hash.Add(label, StringComparer.Ordinal);
        return hash.ToHashCode();
    }
}
