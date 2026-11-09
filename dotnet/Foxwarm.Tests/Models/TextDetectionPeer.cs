using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

internal sealed class TextDetectionPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    internal Uri Endpoint { get; }
    internal ConcurrentQueue<string> Texts { get; } = new();
    internal Func<HttpContext, string, Task<bool>>? Intercept { get; set; }
    internal Func<JsonObject, JsonObject>? Transform { get; set; }
    internal string? Authorization { get; private set; }

    // Label returned for a detected value; others are reported as `secret`.
    internal ConcurrentDictionary<string, string> Labels { get; } = new(StringComparer.Ordinal);
    private readonly string[] secrets;

    private TextDetectionPeer(WebApplication app, string[] secrets)
    {
        this.app = app;
        this.secrets = secrets;
        Endpoint = new Uri(app.Urls.Single() + "/classify");
    }

    internal static async Task<TextDetectionPeer> StartAsync(params string[] secrets)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        TextDetectionPeer? peer = null;
        app.MapPost("/classify", context => peer!.Handle(context));
        await app.StartAsync();
        return peer = new(app, secrets);
    }

    private async Task Handle(HttpContext context)
    {
        Assert.True(context.Request.ContentLength > 0);
        Assert.False(context.Request.Headers.ContainsKey("Transfer-Encoding"));
        Authorization = context.Request.Headers.Authorization;
        var request = (await JsonNode.ParseAsync(context.Request.Body))!.AsObject();
        var text = request["text"]!.GetValue<string>();
        Assert.InRange(request["threshold"]!.GetValue<double>(), 0, 1);
        Texts.Enqueue(text);
        if (Intercept is not null && await Intercept(context, text))
            return;
        var entities = new JsonArray();
        foreach (var secret in secrets)
        {
            var index = 0;
            while ((index = text.IndexOf(secret, index, StringComparison.Ordinal)) >= 0)
            {
                var start = Encoding.UTF8.GetByteCount(text[..index]);
                entities.Add(
                    new JsonObject
                    {
                        ["start"] = start,
                        ["end"] = start + Encoding.UTF8.GetByteCount(secret),
                        ["score"] = 0.99,
                        ["label"] = Labels.GetValueOrDefault(secret, "secret"),
                    }
                );
                index += secret.Length;
            }
        }
        var response = new JsonObject
        {
            ["entities"] = entities,
            ["offset_unit"] = "utf8_bytes",
            ["input_bytes"] = Encoding.UTF8.GetByteCount(text),
            ["input_tokens"] = text.Length,
        };
        await context.Response.WriteAsJsonAsync(Transform?.Invoke(response) ?? response);
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        await app.DisposeAsync();
    }
}

// An owned data root whose instance key supplies text-redaction placeholders.
internal sealed class TextRedactionKeys : IDisposable
{
    private readonly TempDirectory temp = new();
    internal Foxwarm.Secrets.InstanceSecrets Secrets { get; }
    internal string DataRoot => temp.Path;

    internal TextRedactionKeys() => Secrets = new(temp.Path);

    public void Dispose()
    {
        Secrets.Dispose();
        temp.Dispose();
    }
}
