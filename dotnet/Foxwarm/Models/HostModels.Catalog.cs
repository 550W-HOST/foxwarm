using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

/// <summary>One advisory entry of the root <c>catalog</c>: a selectable model key and its description.</summary>
internal sealed record ModelCatalogEntry(string Key, string Description);

internal sealed partial class HostModels
{
    private IReadOnlyList<ModelCatalogEntry> catalogEntries = [];

    /// <summary>
    /// The user's advisory model recommendations in document order. Presentation only: it never
    /// routes, restricts or changes selection.
    /// </summary>
    internal IReadOnlyList<ModelCatalogEntry> Catalog =>
        owner is null ? catalogEntries : Capture().Catalog;

    /// <summary>Concrete leaves a selectable key can reach within this captured configuration.</summary>
    internal IReadOnlyList<ConcreteHostModel> ReachableLeaves(string key)
    {
        if (owner is not null)
            return Capture().ReachableLeaves(key);
        if (!entries.TryGetValue(key, out var model))
            return [];
        if (!model.IsVirtual)
            return [model];
        return model
            .Targets.Select(target => entries.GetValueOrDefault(target))
            .OfType<ConcreteHostModel>()
            .ToArray();
    }

    /// <summary>
    /// The price shared by every reachable leaf of a key, or null when any leaf has no complete
    /// pricing or the leaves differ.
    /// </summary>
    internal (double Cached, double Input, double Output)? SharedPrice(string key)
    {
        var leaves = ReachableLeaves(key);
        (double Cached, double Input, double Output)? shared = null;
        foreach (var leaf in leaves)
        {
            if (leaf.Configuration["pricing"] is not JsonObject pricing)
                return null;
            if (
                SessionWait.Number(pricing["cached"]) is not double cached
                || SessionWait.Number(pricing["input"]) is not double input
                || SessionWait.Number(pricing["output"]) is not double output
            )
                return null;
            if (shared is null)
                shared = (cached, input, output);
            else if (shared != (cached, input, output))
                return null;
        }
        return shared;
    }

    /// <summary>Formats a price rate for the snapshot catalog without locale influence.</summary>
    internal static string FormatRate(double rate) =>
        rate.ToString("R", CultureInfo.InvariantCulture);

    private static IReadOnlyList<ModelCatalogEntry> ParseCatalog(
        JsonObject root,
        Dictionary<string, ConcreteHostModel> models
    )
    {
        if (!root.TryGetPropertyValue("catalog", out var raw) || raw is null)
            return [];
        if (raw is not JsonObject map)
            throw new InvalidDataException(
                "Models catalog must be a map from model key to description."
            );
        var result = new List<ModelCatalogEntry>();
        foreach (var (key, value) in map)
        {
            if (!models.ContainsKey(key))
                throw new InvalidDataException(
                    $"Models catalog key '{key}' is not a configured selectable model key."
                );
            if (
                value is not JsonValue text
                || !text.TryGetValue<string>(out var description)
                || description.Trim().Length == 0
            )
                throw new InvalidDataException(
                    $"Models catalog description for '{key}' must be a nonempty string."
                );
            result.Add(new ModelCatalogEntry(key, description.Trim()));
        }
        return result;
    }

    /// <summary>
    /// Selectable keys of a configuration document, used to keep structured saves from leaving
    /// dangling catalog keys. The document's own catalog is ignored.
    /// </summary>
    internal static HashSet<string> SelectableKeys(JsonObject root, JsonObject app)
    {
        var withoutCatalog = (JsonObject)root.DeepClone();
        withoutCatalog.Remove("catalog");
        return Parse(withoutCatalog, app).entries.Keys.ToHashSet(StringComparer.Ordinal);
    }
}
