using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Foxwarm.Telemetry;

internal sealed partial class FoxwarmTraces : IDisposable
{
    private const string SourceName = "Foxwarm";
    private const string SessionAttribute = "gen_ai.conversation.id";
    private const int FlushTimeoutMs = 5000;
    private readonly ActivitySource source = new(
        new ActivitySourceOptions(SourceName)
        {
            Version = ProductVersion.Value,
            TelemetrySchemaUrl = "https://opentelemetry.io/schemas/1.41.1",
        }
    );
    private readonly TracerProvider provider;
    private readonly HttpClient http;
    private readonly TraceContent content;

    private FoxwarmTraces(OtlpConfiguration config, HttpClient http)
    {
        this.http = http;
        content = config.Content;
        try
        {
            var exporter = new OtlpTraceExporter(
                new OtlpExporterOptions
                {
                    Endpoint = config.Endpoint!,
                    Protocol = OtlpExportProtocol.HttpProtobuf,
                    Headers = "",
                    TimeoutMilliseconds = 3000,
                    HttpClientFactory = () => http,
                }
            );
            provider = Sdk.CreateTracerProviderBuilder()
                .SetResourceBuilder(
                    ResourceBuilder
                        .CreateEmpty()
                        .AddService("foxwarm", serviceVersion: ProductVersion.Value)
                )
                .SetSampler(new AlwaysOnSampler())
                .AddSource(SourceName)
                .AddProcessor(new FoxwarmBatchProcessor(exporter, source))
                .Build();
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    internal static FoxwarmTraces? Open(ModelConfiguration configuration)
    {
        var app = configuration.AppConfiguration;
        if (OtlpConfiguration.Capture(app) is not { Enabled: true } config)
            return null;
        var missing = new List<string>();
        // Resolve only the OTLP header sink. Unavailable credentials for other services must
        // not stop tracing, and a missing OTLP credential must never produce an unauthenticated export.
        var otlp = new JsonObject { ["otlp"] = app["otlp"]?.DeepClone() };
        var resolved = configuration.Secrets.Resolve(
            otlp,
            SecretSinks.App,
            "OTLP configuration",
            missing
        );
        if (missing.Count != 0)
        {
            Console.Error.WriteLine(
                "OTLP tracing disabled because a header secret is unavailable. Check Setup and restart Main."
            );
            return null;
        }
        var http = new HttpClient(
            new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }
        )
        {
            Timeout = TimeSpan.FromSeconds(3),
        };
        try
        {
            foreach (var name in config.Headers.Keys)
            {
                var value = SessionWait.Text(resolved["otlp"]?["headers"]?[name]);
                if (
                    string.IsNullOrWhiteSpace(value)
                    || value.Contains('\r')
                    || value.Contains('\n')
                    || !http.DefaultRequestHeaders.TryAddWithoutValidation(name, value)
                )
                {
                    http.Dispose();
                    Console.Error.WriteLine(
                        "OTLP tracing disabled because a header secret did not resolve to a valid HTTP header value."
                    );
                    return null;
                }
            }
            return new(config, http);
        }
        catch
        {
            http.Dispose();
            throw;
        }
    }

    internal Activity? StartRun(string sessionId, string turnId)
    {
        var span = Start("foxwarm.run", ActivityKind.Internal, sessionId, root: true);
        span?.SetTag("foxwarm.turn.id", turnId);
        return span;
    }

    private Activity? Start(string name, ActivityKind kind, string sessionId, bool root = false)
    {
        var parent = root ? null : Activity.Current;
        while (
            parent is not null
            && (parent.Source != source || !Equals(parent.GetTagItem(SessionAttribute), sessionId))
        )
            parent = parent.Parent;
        var context =
            parent?.Context
            ?? new ActivityContext(
                ActivityTraceId.CreateRandom(),
                default,
                ActivityTraceFlags.None
            );
        var span = source.StartActivity(name, kind, context);
        if (sessionId.Length != 0)
            span?.SetTag(SessionAttribute, sessionId);
        return span;
    }

    internal static void End(Activity? span, string outcome, string? errorType = null)
    {
        if (span is null)
            return;
        span.SetTag("foxwarm.outcome", outcome);
        if (errorType is not null)
            span.SetTag("error.type", errorType);
        if (outcome is "failed" or "cancelled" or "skipped")
            span.SetStatus(ActivityStatusCode.Error);
        else
            span.SetStatus(ActivityStatusCode.Ok);
    }

    public void Dispose()
    {
        source.Dispose();
        if (!provider.Shutdown(FlushTimeoutMs))
            Console.Error.WriteLine(
                "OTLP trace export did not drain before the shutdown deadline."
            );
        http.Dispose();
        provider.Dispose();
    }

    // AddSource matches names across the process. Filter by the instance that owns the
    // destination before enqueueing so co-hosted Main instances cannot mix destinations.
    private sealed class FoxwarmBatchProcessor(
        BaseExporter<Activity> exporter,
        ActivitySource source
    )
        : BatchExportProcessor<Activity>(
            exporter,
            maxQueueSize: 512,
            scheduledDelayMilliseconds: 1000,
            exporterTimeoutMilliseconds: 3000,
            maxExportBatchSize: 64
        )
    {
        public override void OnEnd(Activity activity)
        {
            if (activity.Source == source && activity.Recorded)
                base.OnEnd(activity);
        }
    }
}
