using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// A catalog-owned projection only: canonical source IDs and all other model identities stay intact.
internal sealed class ModelHistoryCompatibility(IReadOnlyDictionary<string, string> targets)
{
    internal static ModelHistoryCompatibility Exact { get; } =
        new(new Dictionary<string, string>());

    internal bool Matches(string? source, string destination) =>
        source is not null && Resolve(source) == Resolve(destination);

    private string Resolve(string key) => targets.TryGetValue(key, out var target) ? target : key;

    internal static ModelHistoryCompatibility Build(
        IReadOnlyDictionary<string, ConcreteHostModel> entries
    )
    {
        var models = entries
            .Values.Where(model => !model.IsVirtual)
            .DistinctBy(model => model.Key)
            .ToDictionary(model => model.Key, StringComparer.Ordinal);
        var providers = models
            .Values.GroupBy(model => model.ProviderKey)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var providerTargets = providers.ToDictionary(
            pair => pair.Key,
            pair => Reference(pair.Value.Configuration, "sameProviderAs"),
            StringComparer.Ordinal
        );
        var checkedProviders = new HashSet<string>(StringComparer.Ordinal);
        var visitingProviders = new HashSet<string>(StringComparer.Ordinal);
        void CheckProvider(string key)
        {
            if (checkedProviders.Contains(key))
                return;
            if (!visitingProviders.Add(key))
                throw new InvalidDataException(
                    "sameProviderAs reference cycle at provider " + key + "."
                );
            if (providerTargets[key] is { } target)
            {
                if (!providers.ContainsKey(target))
                    throw new InvalidDataException(
                        $"Provider {key} sameProviderAs requires a known concrete provider: {target}."
                    );
                CheckProvider(target);
            }
            visitingProviders.Remove(key);
            checkedProviders.Add(key);
        }
        foreach (var key in providers.Keys)
            CheckProvider(key);
        var resolved = new Dictionary<string, string>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        string Visit(string providerKey, string id)
        {
            var key = id.Length == 0 ? providerKey : providerKey + "/" + id;
            if (resolved.TryGetValue(key, out var ready))
                return ready;
            if (!visiting.Add(key))
                throw new InvalidDataException(
                    "History compatibility reference cycle at " + key + "."
                );
            var result = key;
            if (
                models.TryGetValue(key, out var model)
                && Reference(model.Configuration, "sameModelAs") is { } reference
            )
            {
                // Try the whole local ID before the whole qualified key: model IDs may contain slashes.
                if (
                    !models.TryGetValue(providerKey + "/" + reference, out var target)
                    && !models.TryGetValue(reference, out target)
                )
                    throw new InvalidDataException(
                        $"Model {key} sameModelAs requires a known concrete model: {reference}."
                    );
                result = Visit(target.ProviderKey, target.ModelId);
            }
            else if (providerTargets[providerKey] is { } provider)
                // A provider mapping also covers IDs absent from the target's configured model list.
                result = Visit(provider, id);
            visiting.Remove(key);
            resolved.Add(key, result);
            return result;
        }
        foreach (var model in models.Values)
            Visit(model.ProviderKey, model.ModelId);
        // Historical IDs not configured in this capture keep exact-ID fallback, including inferred intermediates.
        return new ModelHistoryCompatibility(
            models.Keys.ToDictionary(key => key, key => resolved[key], StringComparer.Ordinal)
        );
    }

    internal static string? Reference(JsonObject configuration, string field)
    {
        if (!configuration.ContainsKey(field))
            return null;
        var text = SessionWait.Text(configuration[field])?.Trim();
        return !string.IsNullOrEmpty(text)
            ? text
            : throw new InvalidDataException(field + " must be a nonempty string.");
    }
}
