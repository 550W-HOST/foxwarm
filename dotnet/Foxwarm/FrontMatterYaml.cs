using YamlDotNet.Serialization;

namespace Foxwarm;

// Frontmatter's untyped YAML rules differ from configuration: untagged numbers
// and booleans remain strings, duplicate keys take the last value, and merge keys
// are ordinary keys. Keep that parser, but construct its two collection shapes
// directly rather than discovering their constructors through reflection.
internal static class FrontMatterYaml
{
    internal static object? Parse(string text) =>
        new DeserializerBuilder()
            .WithObjectFactory(type =>
                type == typeof(Dictionary<object, object>) ? new Dictionary<object, object>()
                : type == typeof(List<object>) ? new List<object>()
                : throw new InvalidOperationException("Unsupported frontmatter collection type.")
            )
            .Build()
            .Deserialize<object>(text);
}
