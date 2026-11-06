using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class RequestSizeDiagnosticsTests
{
    [Theory]
    [InlineData(400, "context_length_exceeded", true)]
    [InlineData(400, "prompt is too long", true)]
    [InlineData(413, "entity rejected", true)]
    [InlineData(400, "invalid parameter", false)]
    public async Task Ordinary_provider_failures_include_size_only_for_context_rejections(
        int status,
        string body,
        bool expected
    )
    {
        using var http = new HttpClient(new Reject(status, body));
        var tools = new JsonArray(
            new JsonObject { ["name"] = "fixture", ["description"] = "Inspect test data" }
        );
        var options = new ResponsesClientOptions(
            new Uri("http://localhost"),
            "m",
            "a/m",
            "",
            "Base instructions",
            100
        )
        {
            Tools = tools,
        };
        var models = HostModels.Parse(
            JsonNode
                .Parse(
                    """{"providers":{"a":{"providerType":"anthropic","baseUrl":"http://localhost","models":["m"]}}}"""
                )!
                .AsObject(),
            new JsonObject()
        );
        var snapshot = ConditionalMemory.BuildCurrentModelSnapshot("a/m", "Lasting Agent rules");
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "current request" }),
            },
        };
        var owner = new ModelRequestOwner(http, options, new ModelRouting());
        ModelRetryEvent? notice = null;
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            owner.RequestAsync(
                "s",
                models,
                "a/m",
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult(options.Instructions + "\n\n" + snapshot),
                value =>
                {
                    notice = value;
                    return Task.FromResult(false);
                },
                null,
                null,
                null,
                CancellationToken.None
            )
        );
        Assert.Equal(expected, error.Message.Contains("Estimated request tokens:"));
        Assert.Equal(expected, notice!.Reason.Contains("Estimated request tokens:"));
        if (expected)
        {
            Assert.Contains(
                "base instructions " + CompactCandidateBuilder.Tokens(options.Instructions),
                error.Message
            );
            Assert.Contains(
                "memory snapshot " + CompactCandidateBuilder.Tokens(snapshot),
                error.Message
            );
            Assert.Contains(
                "tool declarations " + CompactCandidateBuilder.Tokens(tools.ToJsonString()),
                error.Message
            );
            Assert.Contains("history/request remainder ", error.Message);
        }
    }

    private sealed class Reject(int status, string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        ) =>
            Task.FromResult(
                new HttpResponseMessage((HttpStatusCode)status)
                {
                    Content = new StringContent(body),
                }
            );
    }
}
