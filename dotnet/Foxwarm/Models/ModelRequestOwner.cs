using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class ModelRequestOwner(
    HttpClient http,
    ResponsesClientOptions defaults,
    ModelRouting routing,
    Func<int, CancellationToken, Task>? delay = null,
    ResponsesWsTransport? websockets = null,
    Foxwarm.Images.ImageBlobStore? images = null,
    string imageOutputFormat = "webp",
    LlmRequestJournalStore? journal = null
)
{
    internal static int RetryDelay(int failedAttempt) =>
        failedAttempt switch
        {
            <= 1 => 2000,
            2 => 5000,
            3 => 10000,
            4 => 20000,
            5 => 40000,
            _ => 60000,
        };

    internal sealed record CapturedRequest(
        HostModels Catalog,
        string RouteKey,
        string? RawEffort,
        ConcreteHostModel Route,
        ModelRouting.Request? Routing
    );

    internal CapturedRequest Capture(HostModels catalog, string routeKey, string? rawEffort)
    {
        if (rawEffort is not null && !HostModels.Efforts.Contains(rawEffort))
            throw new ModelPreparationException("Invalid requested model effort.");
        routeKey = catalog.Contains(routeKey) ? routeKey : catalog.DefaultKey;
        var route = catalog.Resolve(routeKey);
        var request = route.IsVirtual ? routing.Begin(route.Key, route) : null;
        if (request is null)
            routing.Clear(routeKey);
        return new(catalog, routeKey, rawEffort, route, request);
    }

    internal Task<ChatResult> RequestAsync(
        string sessionId,
        HostModels catalog,
        string routeKey,
        string? rawEffort,
        string cacheKey,
        string turnId,
        IReadOnlyList<JsonObject> history,
        Func<ConcreteHostModel, CancellationToken, Task<string>> prompt,
        Func<ModelRetryEvent, Task<bool>>? retry,
        Action? beginAttempt,
        Action<string, ResponsesStreamProgress>? progress,
        Action<Exception>? warning,
        CancellationToken cancellationToken,
        ModelRequestScope scope = ModelRequestScope.LowLevel,
        Func<JsonArray>? definitions = null,
        Func<CancellationToken, Task<IReadOnlyList<JsonObject>?>>? prepareRetry = null,
        string journalPurpose = "low-level",
        int journalIteration = 0,
        Action<string>? journalRequestStarted = null
    ) =>
        RequestAsync(
            sessionId,
            Capture(catalog, routeKey, rawEffort),
            cacheKey,
            turnId,
            history,
            prompt,
            retry,
            beginAttempt,
            progress,
            warning,
            cancellationToken,
            scope,
            definitions,
            prepareRetry,
            journalPurpose,
            journalIteration,
            journalRequestStarted
        );

    internal async Task<ChatResult> RequestAsync(
        string sessionId,
        CapturedRequest captured,
        string cacheKey,
        string turnId,
        IReadOnlyList<JsonObject> history,
        Func<ConcreteHostModel, CancellationToken, Task<string>> prompt,
        Func<ModelRetryEvent, Task<bool>>? retry,
        Action? beginAttempt,
        Action<string, ResponsesStreamProgress>? progress,
        Action<Exception>? warning,
        CancellationToken cancellationToken,
        ModelRequestScope scope = ModelRequestScope.LowLevel,
        Func<JsonArray>? definitions = null,
        Func<CancellationToken, Task<IReadOnlyList<JsonObject>?>>? prepareRetry = null,
        string journalPurpose = "low-level",
        int journalIteration = 0,
        Action<string>? journalRequestStarted = null
    )
    {
        var catalog = captured.Catalog;
        var route = captured.Route;
        var request = captured.Routing;
        var rawEffort = captured.RawEffort;
        const int maxAttempts = 6;
        long? requestStarted = null;
        string? journalRequestId = null;
        var journalAttempt = 0;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var selection = request is null ? null : routing.Select(request, cacheKey);
            var leaf =
                selection is null ? route
                : catalog.Contains(selection.TargetKey) ? catalog.Resolve(selection.TargetKey)
                : throw new ModelPreparationException(
                    "Virtual target is missing from the captured catalog."
                );
            if (leaf.IsVirtual)
                throw new ModelPreparationException("Virtual targets must be concrete models.");
            var effort =
                rawEffort is not null && leaf.AllowedEfforts.Contains(rawEffort)
                    ? rawEffort
                    : leaf.DefaultEffort!;
            // Local canonical/snapshot/cache/plan preparation is deliberately outside provider retry handling.
            var instructions = await prompt(leaf, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            var providerCache = ProviderPromptCache.Resolve(
                leaf.ProviderType,
                sessionId,
                cacheKey,
                scope
            );
            var requestDefaults = definitions is null
                ? defaults
                : defaults with
                {
                    Tools = definitions(),
                };
            var options = ConfiguredModelRequests.Plan(
                leaf,
                requestDefaults,
                effort,
                instructions,
                providerCache,
                turnId
            );
            if (journal is not null && journalRequestId is null)
            {
                journalRequestId = await journal.BeginRequestAsync(
                    sessionId,
                    journalPurpose,
                    journalIteration,
                    instructions,
                    requestDefaults.Tools ?? new JsonArray(),
                    history,
                    captured.RouteKey,
                    cacheKey,
                    cancellationToken
                );
                journalAttempt = 0;
            }
            var currentJournalRequestId = journalRequestId;
            var currentJournalAttempt = journal is null ? 0 : ++journalAttempt;
            if (journal is not null && currentJournalRequestId is not null)
            {
                journalRequestStarted?.Invoke(currentJournalRequestId);
                options = options with
                {
                    JournalAttemptStart = payload =>
                        JournalAttemptStartAsync(
                            journal,
                            currentJournalRequestId,
                            currentJournalAttempt,
                            leaf.Key,
                            request is null ? null : route.Key,
                            leaf.ProviderType,
                            payload,
                            instructions,
                            cancellationToken
                        ),
                };
            }
            var prepared = ConcreteRequestHistory.PrepareRequest(history, leaf.Key);
            if (images is not null)
            {
                try
                {
                    prepared = await images.HydrateAsync(
                        prepared,
                        leaf.ProviderType == "openai-completions" ? "completions"
                            : leaf.ProviderType is "openai" or "openai-responses" or "openai-ws"
                                ? "responses"
                            : "anthropic",
                        outputFormat: imageOutputFormat,
                        token: cancellationToken
                    );
                }
                catch (Foxwarm.Images.ImageInputException error)
                {
                    throw new ModelPreparationException(error.Message, error);
                }
            }
            var service = ConfiguredModelRequests.CreatePreparedService(
                http,
                leaf,
                options,
                providerCache,
                progress,
                websockets,
                scope
            );
            beginAttempt?.Invoke();
            ModelAttemptFailure failure;
            ChatResult? result = null;
            var succeeded = false;
            try
            {
                requestStarted ??= Stopwatch.GetTimestamp();
                result = await service.ChatAsync(sessionId, prepared, cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                if (journal is not null && currentJournalRequestId is not null)
                {
                    try
                    {
                        await journal
                            .AppendAttemptResultAsync(
                                currentJournalRequestId,
                                currentJournalAttempt,
                                "success",
                                result.AssistantMessage,
                                null,
                                cancellationToken
                            )
                            .ConfigureAwait(false);
                    }
                    catch (Exception journalError)
                    {
                        warning?.Invoke(journalError);
                    }
                    result = result with
                    {
                        JournalRequestId = currentJournalRequestId,
                        JournalAttempt = currentJournalAttempt,
                    };
                }
                if (request is not null)
                    routing.Success(request, leaf.Key);
                if (result.AssistantMessage is JsonObject message)
                {
                    var meta = message["__meta"] as JsonObject ?? new JsonObject();
                    var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var duration = Stopwatch.GetElapsedTime(requestStarted.Value).TotalMilliseconds;
                    meta["timestamp"] = completedAt;
                    meta["llmRequestTiming"] = new JsonObject
                    {
                        ["startedAt"] = completedAt - duration,
                        ["completedAt"] = completedAt,
                        ["durationMs"] = duration,
                    };
                    meta["modelId"] = leaf.Key;
                    if (request is null)
                        meta.Remove("virtualModelKey");
                    else
                        meta["virtualModelKey"] = route.Key;
                    if (meta.Parent is null)
                        message["__meta"] = meta;
                }
                succeeded = true;
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                if (journal is not null && currentJournalRequestId is not null)
                    try
                    {
                        await journal
                            .AppendAttemptResultAsync(
                                currentJournalRequestId,
                                currentJournalAttempt,
                                "abort",
                                null,
                                new JsonObject
                                {
                                    ["message"] = "Request cancelled.",
                                    ["kind"] = "abort",
                                }
                            )
                            .ConfigureAwait(false);
                    }
                    catch (Exception journalError)
                    {
                        warning?.Invoke(journalError);
                    }
                throw;
            }
            catch (ModelPreparationException error)
            {
                throw new ModelPreparationException(
                    ConfiguredModelRequests.SafeReason(error.Message, leaf),
                    error
                );
            }
            catch (UnsupportedResponsesFeatureException)
            {
                throw;
            }
            catch (LlmJournalPreparationException)
            {
                throw;
            }
            catch (Exception error)
            {
                failure = error switch
                {
                    ModelAttemptFailure known => known,
                    ResponsesHttpException response => ModelAttemptFailure.Http(
                        (int)response.StatusCode!,
                        response.ResponseBody
                    ),
                    OperationCanceledException or TimeoutException => new ModelAttemptFailure(
                        "Configured provider request timed out.",
                        "request-error",
                        true,
                        true
                    ),
                    _ => new ModelAttemptFailure(error.Message, "request-error", true, true),
                };
                if (journal is not null && currentJournalRequestId is not null)
                    try
                    {
                        await journal
                            .AppendAttemptResultAsync(
                                currentJournalRequestId,
                                currentJournalAttempt,
                                "failure",
                                null,
                                new JsonObject
                                {
                                    ["kind"] = failure.Kind,
                                    ["message"] = failure.Message,
                                    ["retryable"] = failure.Retryable,
                                    ["countable"] = failure.Countable,
                                }
                            )
                            .ConfigureAwait(false);
                    }
                    catch (Exception journalError)
                    {
                        warning?.Invoke(journalError);
                    }
            }
            finally
            {
                if (!succeeded)
                    result?.FinalizeHistory(null, warning);
            }
            cancellationToken.ThrowIfCancellationRequested();
            var terminalTarget =
                failure.Countable
                && request is not null
                && selection is not null
                && routing.Failed(request, selection).Terminal;
            var final = !failure.Retryable || terminalTarget || attempt == maxAttempts;
            var reason = ModelAttemptFailure.Summary(
                ConfiguredModelRequests.SafeReason(failure.Message, leaf)
            );
            var value = new ModelRetryEvent(
                attempt,
                maxAttempts,
                failure.Kind,
                reason,
                leaf.Key,
                request is null ? null : route.Key,
                failure.Status,
                final ? null : attempt + 1,
                final ? null : RetryDelay(attempt),
                final
            );
            var delivered = false;
            if (retry is not null)
            {
                try
                {
                    delivered = await retry(value);
                }
                catch (Exception error)
                {
                    try
                    {
                        warning?.Invoke(error);
                    }
                    catch { }
                }
            }
            if (final)
                throw new ModelRequestException(
                    $"API request failed after {attempt} attempts: {reason}",
                    value
                )
                {
                    TerminalNoticeDelivered = delivered,
                };
            if (delay is null)
                await Task.Delay(RetryDelay(attempt), cancellationToken);
            else
                await delay(RetryDelay(attempt), cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            // Semantic owner preparation is awaited outside provider failure/health handling.
            if (scope == ModelRequestScope.Canonical && prepareRetry is not null)
            {
                var updated = await prepareRetry(cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                if (updated is not null)
                {
                    history = updated;
                    requestStarted = null;
                    journalRequestId = null;
                    journalAttempt = 0;
                }
            }
        }
        throw new InvalidOperationException("Unreachable attempt limit.");
    }

    private static async Task JournalAttemptStartAsync(
        LlmRequestJournalStore store,
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode payload,
        string effectivePrompt,
        CancellationToken token
    )
    {
        try
        {
            await store
                .AppendAttemptStartAsync(
                    requestId,
                    attempt,
                    concreteModelId,
                    virtualModelKey,
                    providerType,
                    payload,
                    effectivePrompt,
                    token
                )
                .ConfigureAwait(false);
        }
        catch (Exception error)
        {
            throw new LlmJournalPreparationException(
                "LLM journal attempt start could not be made durable.",
                error
            );
        }
    }
}
