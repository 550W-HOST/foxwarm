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
    LlmRequestJournalStore? journal = null,
    ModelInteractionDiagnostics? diagnostics = null
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
        Action<string>? journalRequestStarted = null,
        Func<Task<IReadOnlyList<JsonObject>>>? requestContext = null
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
            journalRequestStarted,
            requestContext
        );

    internal Task<ChatResult> RequestAsync(
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
        Action<string>? journalRequestStarted = null,
        Func<Task<IReadOnlyList<JsonObject>>>? requestContext = null
    ) =>
        RequestAsync(
            sessionId,
            captured,
            cacheKey,
            turnId,
            RequestHistory.FromMutable(history),
            prompt,
            retry,
            beginAttempt,
            progress,
            warning,
            cancellationToken,
            scope,
            definitions,
            prepareRetry is null
                ? null
                : async token =>
                    await prepareRetry(token) is { } updated
                        ? RequestHistory.FromMutable(updated)
                        : null,
            journalPurpose,
            journalIteration,
            journalRequestStarted,
            requestContext
        );

    internal async Task<ChatResult> RequestAsync(
        string sessionId,
        CapturedRequest captured,
        string cacheKey,
        string turnId,
        RequestHistory history,
        Func<ConcreteHostModel, CancellationToken, Task<string>> prompt,
        Func<ModelRetryEvent, Task<bool>>? retry,
        Action? beginAttempt,
        Action<string, ResponsesStreamProgress>? progress,
        Action<Exception>? warning,
        CancellationToken cancellationToken,
        ModelRequestScope scope = ModelRequestScope.LowLevel,
        Func<JsonArray>? definitions = null,
        Func<CancellationToken, Task<RequestHistory?>>? prepareRetry = null,
        string journalPurpose = "low-level",
        int journalIteration = 0,
        Action<string>? journalRequestStarted = null,
        Func<Task<IReadOnlyList<JsonObject>>>? requestContext = null,
        Func<CapturedRequest?>? recaptureSelection = null,
        Func<
            ConcreteHostModel,
            string,
            bool,
            CancellationToken,
            Task<RequestHistory?>
        >? adoptSelection = null,
        Func<JsonObject, bool, Task<JsonObject>>? commitAssistantSegment = null
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
        Task manifestCompletion = Task.CompletedTask;
        var interaction = diagnostics?.Begin(journalIteration);
        var baseHistory = history;
        var retainedContext = requestContext is null
            ? Array.Empty<JsonObject>()
            : (await requestContext().ConfigureAwait(false)).ToArray();
        history = baseHistory.WithContext(retainedContext);
        try
        {
            for (var attempt = 1; attempt <= maxAttempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var explicitSelectionChanged = false;
                if (
                    attempt > 1
                    && scope == ModelRequestScope.Canonical
                    && recaptureSelection?.Invoke() is { } next
                )
                {
                    captured = next;
                    catalog = next.Catalog;
                    route = next.Route;
                    request = next.Routing;
                    rawEffort = next.RawEffort;
                    explicitSelectionChanged = true;
                    interaction = diagnostics?.Begin(journalIteration);
                    requestStarted = null;
                    journalRequestId = null;
                    journalAttempt = 0;
                }
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
                if (scope == ModelRequestScope.Canonical && adoptSelection is not null)
                {
                    var updated = await adoptSelection(
                        leaf,
                        effort,
                        attempt > 1 && !explicitSelectionChanged && request is not null,
                        cancellationToken
                    );
                    cancellationToken.ThrowIfCancellationRequested();
                    if (updated is not null)
                    {
                        baseHistory = updated;
                        history = baseHistory.WithContext(retainedContext);
                        interaction = diagnostics?.Begin(journalIteration);
                        // An adoption notice refreshes journal input, but the same
                        // response still includes elapsed retries and failover.
                        journalRequestId = null;
                        journalAttempt = 0;
                    }
                }
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
                    turnId,
                    journalPurpose
                );
                options = options with
                {
                    Images = images,
                    Diagnostics = interaction?.StartAttempt(
                        leaf,
                        options,
                        attempt,
                        request is null ? null : route.Key
                    ),
                };
                if (journal is not null && journalRequestId is null)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    // Accepted manifests must remain available to a later prepared start/abort,
                    // even when Stop arrives before this early write reaches the writer.
                    var admission = await journal.EnqueueRequestAsync(
                        sessionId.Length == 0 ? null : sessionId,
                        journalPurpose,
                        journalIteration,
                        instructions,
                        requestDefaults.Tools ?? new JsonArray(),
                        RequestHistoryRepair.SelectAndRepair(history),
                        captured.RouteKey,
                        cacheKey
                    );
                    journalRequestId = admission.RequestId;
                    manifestCompletion = admission.Completion;
                    journalAttempt = 0;
                }
                var currentJournalRequestId = journalRequestId;
                var currentJournalAttempt = journal is null ? 0 : ++journalAttempt;
                if (journal is not null && currentJournalRequestId is not null)
                    journalRequestStarted?.Invoke(currentJournalRequestId);
                var attemptPrepared = false;
                options = options with
                {
                    CommitAssistantSegment =
                        scope == ModelRequestScope.Canonical && commitAssistantSegment is not null
                            ? async (message, deliver) =>
                            {
                                var meta = message["__meta"]!.AsObject();
                                if (currentJournalRequestId is not null)
                                    meta["llmRequestId"] = currentJournalRequestId;
                                meta["llmAttempt"] = currentJournalAttempt;
                                meta["modelId"] = leaf.Key;
                                if (request is not null)
                                    meta["virtualModelKey"] = route.Key;
                                return await commitAssistantSegment(message, deliver)
                                    .ConfigureAwait(false);
                            }
                            : null,
                    AttemptPrepared = async payload =>
                    {
                        // Serializers call this only after the complete semantic body exists.
                        // A cancelled plan still records its durable start/abort, without a new notice.
                        if (!cancellationToken.IsCancellationRequested)
                            beginAttempt?.Invoke();
                        if (journal is not null && currentJournalRequestId is not null)
                            await JournalAttemptStartAsync(
                                    journal,
                                    currentJournalRequestId,
                                    currentJournalAttempt,
                                    leaf.Key,
                                    request is null ? null : route.Key,
                                    leaf.ProviderType,
                                    payload,
                                    instructions,
                                    manifestCompletion
                                )
                                .ConfigureAwait(false);
                        attemptPrepared = true;
                        cancellationToken.ThrowIfCancellationRequested();
                    },
                };
                var prepared = ConcreteRequestHistory.PrepareRequest(history.Messages, leaf.Key);
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
                            outputFormat: leaf.ProviderImageOutputFormat,
                            token: cancellationToken,
                            concreteModelId: leaf.Key
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
                cancellationToken.ThrowIfCancellationRequested();
                ModelAttemptFailure failure;
                ChatResult? result = null;
                var succeeded = false;
                try
                {
                    requestStarted ??= Stopwatch.GetTimestamp();
                    result = await service.ChatAsync(sessionId, prepared, cancellationToken);
                    cancellationToken.ThrowIfCancellationRequested();
                    result = result with { Usage = ModelUsageCost.Complete(leaf, result) };
                    var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var duration = Stopwatch.GetElapsedTime(requestStarted.Value).TotalMilliseconds;
                    if (result.AssistantMessage is JsonObject message)
                    {
                        var meta = message["__meta"] as JsonObject ?? new JsonObject();
                        meta["timestamp"] = completedAt;
                        meta["llmRequestTiming"] = new JsonObject
                        {
                            ["startedAt"] = completedAt - duration,
                            ["completedAt"] = completedAt,
                            ["durationMs"] = duration,
                        };
                        meta["modelId"] = leaf.Key;
                        if (result.Usage is not null)
                            meta["usage"] = result.Usage.DeepClone();
                        if (request is null)
                            meta.Remove("virtualModelKey");
                        else
                            meta["virtualModelKey"] = route.Key;
                        if (meta.Parent is null)
                            message["__meta"] = meta;
                    }
                    if (journal is not null && currentJournalRequestId is not null)
                    {
                        result = result with
                        {
                            JournalRequestId = currentJournalRequestId,
                            JournalAttempt = currentJournalAttempt,
                        };
                        try
                        {
                            await journal
                                .AppendChatResultAsync(
                                    currentJournalRequestId,
                                    currentJournalAttempt,
                                    JournalResult(result),
                                    cancellationToken
                                )
                                .ConfigureAwait(false);
                        }
                        catch (Exception journalError)
                        {
                            warning?.Invoke(journalError);
                        }
                    }
                    if (request is not null)
                        routing.Success(request, leaf.Key);
                    succeeded = true;
                    return result;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    if (
                        attemptPrepared
                        && journal is not null
                        && currentJournalRequestId is not null
                    )
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
                catch (Exception) when (!attemptPrepared)
                {
                    // Serialization and local attempt callbacks are not provider failures.
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
                            response.ClassificationBody
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
                // Notice/channel delivery can yield to Stop or Run queued after the failed attempt.
                cancellationToken.ThrowIfCancellationRequested();
                if (final)
                    throw new ModelRequestException(
                        $"API request failed after {attempt} attempts: {reason}",
                        value,
                        scope
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
                        baseHistory = updated;
                        history = baseHistory.WithContext(retainedContext);
                        interaction = diagnostics?.Begin(journalIteration);
                        requestStarted = null;
                        journalRequestId = null;
                        journalAttempt = 0;
                    }
                    if (requestContext is not null)
                    {
                        var nextContext = (await requestContext().ConfigureAwait(false)).ToArray();
                        var changed =
                            retainedContext.Length != nextContext.Length
                            || retainedContext
                                .Zip(nextContext)
                                .Any(pair => !JsonNode.DeepEquals(pair.First, pair.Second));
                        if (changed)
                        {
                            retainedContext = nextContext;
                            history = baseHistory.WithContext(retainedContext);
                            interaction = diagnostics?.Begin(journalIteration);
                            requestStarted = null;
                            journalRequestId = null;
                            journalAttempt = 0;
                        }
                    }
                }
            }
            throw new InvalidOperationException("Unreachable attempt limit.");
        }
        catch (Exception preparationOrRequestError)
        {
            if (interaction is not null)
                await interaction.MoveToErrorAsync().ConfigureAwait(false);
            // Local preparation can fail before the accepted manifest settles. Resolve it before returning.
            try
            {
                await manifestCompletion.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
                when (preparationOrRequestError is OperationCanceledException
                    && cancellationToken.IsCancellationRequested
                )
            {
                // Both failures describe this caller's cancellation; retain its cancellation outcome.
            }
            catch (Exception persistenceError)
                when (!ReferenceEquals(preparationOrRequestError, persistenceError))
            {
                throw new LlmJournalPreparationException(
                    "LLM request preparation and its pending journal write failed.",
                    new AggregateException(preparationOrRequestError, persistenceError)
                );
            }
            throw;
        }
    }

    private static ChatResult JournalResult(ChatResult result)
    {
        if (result.CommittedSegments.Count == 0)
            return result;
        var assistant = result.AssistantMessage is null
            ? new JsonObject { ["role"] = "model" }
            : (JsonObject)result.AssistantMessage.DeepClone();
        assistant["parts"] = new JsonArray(
            result
                .CommittedSegments.Append(result.AssistantMessage)
                .Where(message => message is not null)
                .SelectMany(message => message!["parts"] as JsonArray ?? [])
                .Select(part => part?.DeepClone())
                .ToArray()
        );
        return result with { AssistantMessage = assistant };
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
        Task manifestCompletion
    )
    {
        try
        {
            var receipt = await store
                .EnqueueAttemptStartAsync(
                    requestId,
                    attempt,
                    concreteModelId,
                    virtualModelKey,
                    providerType,
                    payload,
                    effectivePrompt
                )
                .ConfigureAwait(false);
            await Task.WhenAll(manifestCompletion, receipt.Completion).ConfigureAwait(false);
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
