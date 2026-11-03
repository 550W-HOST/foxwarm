using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

/// <summary>
/// Setup model listing reports limits and image support only when the provider declares them.
/// </summary>
public sealed class SetupProviderModelListTests
{
    [Fact]
    public async Task Anthropic_listing_reports_declared_limits_and_image_input()
    {
        var models = await List(
            "anthropic",
            """
            {"data":[
              {"type":"model","id":"claude-a","max_input_tokens":1000000,"max_tokens":128000,
               "capabilities":{"image_input":{"supported":true},"batch":{"supported":true}}},
              {"type":"model","id":"claude-b","max_input_tokens":200000,"max_tokens":null,
               "capabilities":{"image_input":{"supported":false}}},
              {"type":"model","id":"claude-c","capabilities":null}
            ],"has_more":false}
            """
        );
        Assert.Equal(
            [
                """{"id":"claude-a","contextLimit":1000000,"maxOutput":128000,"imageInput":true}""",
                """{"id":"claude-b","contextLimit":200000,"imageInput":false}""",
                """{"id":"claude-c"}""",
            ],
            models.Select(model => model.ToJson().ToJsonString())
        );
    }

    [Fact]
    public async Task OpenAI_listing_has_identifiers_only()
    {
        var models = await List(
            "openai-responses",
            """{"object":"list","data":[{"id":"gpt-a","object":"model","created":1,"owned_by":"system"},{"id":"gpt-a"},{"id":" "}]}"""
        );
        Assert.Equal(["""{"id":"gpt-a"}"""], models.Select(model => model.ToJson().ToJsonString()));
    }

    [Fact]
    public async Task Gateway_listing_reads_context_length_completion_limit_and_input_modalities()
    {
        var models = await List(
            "openai-completions",
            """
            {"data":[
              {"id":"vendor/vision","context_length":262144,"top_provider":{"max_completion_tokens":65536},
               "architecture":{"input_modalities":["text","image","file"]}},
              {"id":"vendor/text","context_length":131072.0,"top_provider":{"max_completion_tokens":null},
               "architecture":{"input_modalities":["text"]}},
              {"id":"vendor/odd","context_length":"131072","top_provider":{"max_completion_tokens":0.5},
               "architecture":{"input_modalities":["text",3]}},
              {"id":"vendor/negative","context_length":-1,"architecture":{"input_modalities":[]}}
            ]}
            """
        );
        Assert.Equal(
            [
                """{"id":"vendor/vision","contextLimit":262144,"maxOutput":65536,"imageInput":true}""",
                """{"id":"vendor/text","contextLimit":131072,"imageInput":false}""",
                """{"id":"vendor/odd"}""",
                """{"id":"vendor/negative"}""",
            ],
            models.Select(model => model.ToJson().ToJsonString())
        );
    }

    private static async Task<SetupListedModel[]> List(string providerType, string body)
    {
        using var http = new HttpClient(
            new Handler(() => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            })
        );
        var model = new ConcreteHostModel(
            "p/m",
            "p",
            "m",
            providerType,
            "https://models.example.test/v1",
            "synthetic-key",
            100000,
            [],
            null,
            new JsonObject(),
            []
        );
        return await SetupProviderRequests.ListAsync(http, model, CancellationToken.None);
    }

    private sealed class Handler(Func<HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) => Task.FromResult(respond());
    }
}
