using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed record AskUserResult(JsonObject Response, string? WaitQuestionId);

internal sealed partial class SessionManager
{
    /// <summary>
    /// `ask_user` effect: records a new open question (or closes one) in the Session's strict
    /// save lane. A blocking ask returns the question ID for the caller's terminal wait control.
    /// </summary>
    internal async Task<AskUserResult> AskUserAsync(
        SessionOwner owner,
        JsonObject args,
        string? toolCallId
    )
    {
        Keys(args, ["questions", "afterAsk", "close", "closeNote"], []);
        var asking = args.ContainsKey("questions");
        var closing = args.ContainsKey("close");
        if (asking == closing)
            throw new InvalidDataException("Provide either questions or close.");
        if (closing)
        {
            if (args.ContainsKey("afterAsk"))
                throw new InvalidDataException("afterAsk applies only when asking questions.");
            var target = RequiredString(args, "close").Trim();
            if (target.Length == 0)
                throw new InvalidDataException("close must name an open question.");
            var note = OptionalString(args, "closeNote")?.Trim();
            if (note is { Length: > SessionQuestions.MaxNoteLength })
                throw new InvalidDataException(
                    $"closeNote is longer than {SessionQuestions.MaxNoteLength} characters."
                );
            string? failure = null;
            await owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
            {
                if (SessionQuestions.Resolve(meta, target, "closed", closeNote: note))
                    return target;
                failure = SessionQuestions.NotOpenMessage(meta, target);
                return null;
            });
            if (failure is not null)
                throw new InvalidOperationException(failure);
            return new(
                new JsonObject
                {
                    ["output"] = $"Closed question {target}.",
                    ["questionId"] = target,
                    ["status"] = "closed",
                },
                null
            );
        }
        if (args.ContainsKey("closeNote"))
            throw new InvalidDataException("closeNote applies only with close.");
        var questions = SessionQuestions.ParseQuestions(args["questions"]);
        var external = ClaudeRuntimeState.IsExternal(owner.Entry.Snapshot().AuthorityEnvelope);
        var after = OptionalString(args, "afterAsk") ?? (external ? "continue" : "wait");
        if (after is not ("wait" or "continue"))
            throw new InvalidDataException("afterAsk must be wait or continue.");
        if (external && after == "wait")
            throw new InvalidOperationException(
                "Claude Code runtime supports only afterAsk=continue."
            );
        var id = SessionQuestions.NewId();
        JsonObject? record = null;
        await owner.Entry.SaveLane.MutateQuestionsAsync(meta =>
        {
            record = (JsonObject)
                SessionQuestions.Add(meta, id, questions, toolCallId, after == "wait").DeepClone();
            return id;
        });
        if (record is null)
            throw new InvalidOperationException(
                "The Session is stopping; the question was not asked."
            );
        // External channels have no answer card; they receive the question as plain text.
        BroadcastTransientText(owner, SessionQuestions.ChannelText(record));
        return new(
            new JsonObject
            {
                ["output"] =
                    after == "wait"
                        ? $"Asked question {id}. The Session waits for the user's answer after this tool batch."
                        : $"Asked question {id}. The answer will arrive later as a user message.",
                ["questionId"] = id,
                ["status"] = "open",
            },
            after == "wait" ? id : null
        );
    }

    internal JsonObject QuestionsView(SessionOwner owner) =>
        owner.Entry.WithState(state =>
        {
            var items = SessionQuestions
                .Records(state.Meta)
                .Select(record => (JsonNode?)record.DeepClone())
                .ToArray();
            var waited = SessionWait.Strings(SessionWait.Current(state.Meta)?["waitQuestionIds"]);
            return new JsonObject
            {
                ["revision"] = SessionQuestions.Revision(state.Meta),
                ["waitingQuestionIds"] = new JsonArray(
                    waited.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                ),
                ["questions"] = new JsonArray(items),
            };
        });

    /// <summary>
    /// Admits a structured WebUI answer as user input. The question must still be open when the
    /// owner admits it; a concurrent earlier answer wins and this one fails.
    /// </summary>
    internal async Task AnswerQuestionAsync(SessionOwner owner, string questionId, JsonObject body)
    {
        var record = owner.Entry.WithState(state =>
            SessionQuestions.Find(state.Meta, questionId)?.DeepClone() as JsonObject
        );
        if (record is null)
            throw new KeyNotFoundException(
                $"Question {questionId} does not exist in this Session."
            );
        if (SessionQuestions.Status(record) != "open")
            throw new QuestionNotOpenException(
                $"Question {questionId} is no longer open; it was {SessionQuestions.Status(record)}."
            );
        var answer = SessionQuestions.ParseAnswer(record, body);
        var text = SessionQuestions.RenderAnswer(questionId, record, answer);
        var stored = (JsonObject)answer.DeepClone();
        stored["questionId"] = questionId;
        // The message carries its question texts so the WebUI can show the answer as Q/A
        // pairs after the record itself has been pruned.
        stored["questions"] = new JsonArray(
            record["questions"]!
                .AsArray()
                .Select(question =>
                    (JsonNode?)JsonValue.Create(SessionWait.Text(question?["question"]) ?? "")
                )
                .ToArray()
        );
        var item = new QueueItem(
            QueueItemType.User,
            SessionBoundary.ChannelInput([new JsonObject { ["text"] = text }], "webui"),
            OpenFields: new JsonObject { ["userInput"] = true, ["questionAnswer"] = stored }
        );
        await new SessionRuntime(this).SubmitExternalAsync(
            owner,
            item,
            () =>
            {
                if (!Accepting)
                    throw new InvalidOperationException("Host is shutting down.");
            }
        );
    }
}
