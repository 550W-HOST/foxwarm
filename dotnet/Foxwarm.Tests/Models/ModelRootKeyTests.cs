using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ModelRootKeyTests
{
    private const string Providers = """
        "providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","apiKey":"synthetic-key","models":["m"]}}
        """;

    private static HostModels Load(string rootEntries) =>
        HostModels.Parse(JsonNode.Parse("{" + rootEntries + "}")!.AsObject(), new JsonObject());

    [Fact]
    public void Unrecognized_root_keys_are_ignored_when_models_load()
    {
        var plain = Load("\"default\":\"a/m\"," + Providers);
        var withExtra = Load("\"default\":\"a/m\",\"catalog\":{\"a/m\":\"leftover\"}," + Providers);
        Assert.Equal(plain.DefaultKey, withExtra.DefaultKey);
        Assert.Equal(
            plain.All.Select(model => model.Key).ToArray(),
            withExtra.All.Select(model => model.Key).ToArray()
        );
    }
}
