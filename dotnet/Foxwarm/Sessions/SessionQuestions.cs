using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

/// <summary>
/// Session-owned `ask_user` questions. Records live in authority `meta.questions` so an
/// answerable question survives compaction of its originating tool call and restart.
/// Every transition runs inside the owner's save lane together with the wait/queue state.
/// </summary>
internal static class SessionQuestions
{
    internal const int MaxQuestions = 4;
    internal const int MaxOptions = 6;
    internal const int MaxQuestionLength = 4000;
    internal const int MaxLabelLength = 200;
    internal const int MaxDescriptionLength = 1000;
    internal const int MaxAnswerTextLength = 8000;
    internal const int MaxNoteLength = 2000;
    internal const int MaxOpen = 32;
    internal const int RetainedResolved = 20;

    internal static readonly string[] Statuses = ["open", "answered", "skipped", "closed"];

    internal static JsonArray Items(JsonObject meta) =>
        meta["questions"]?["items"] as JsonArray ?? new JsonArray();

    internal static JsonObject[] Records(JsonObject meta) =>
        Items(meta).OfType<JsonObject>().ToArray();

    internal static JsonObject[] Open(JsonObject meta) =>
        Records(meta).Where(record => Status(record) == "open").ToArray();

    internal static JsonObject? Find(JsonObject meta, string id) =>
        Records(meta).FirstOrDefault(record => SessionWait.Text(record["id"]) == id);

    internal static string Status(JsonObject record) =>
        SessionWait.Text(record["status"]) ?? "open";

    internal static long Revision(JsonObject meta) =>
        (long)(SessionWait.Number(meta["questions"]?["revision"]) ?? 0);

    internal static string NewId() => "q-" + Guid.NewGuid().ToString("N")[..10];

    private static JsonObject Container(JsonObject meta)
    {
        if (meta["questions"] is not JsonObject container)
            meta["questions"] = container = new JsonObject();
        if (container["items"] is not JsonArray)
            container["items"] = new JsonArray();
        return container;
    }

    private static void Touch(JsonObject meta)
    {
        var container = Container(meta);
        container["revision"] = Revision(meta) + 1;
        var items = container["items"]!.AsArray();
        var resolved = items
            .OfType<JsonObject>()
            .Where(record => Status(record) != "open")
            .ToArray();
        // Keep every open question and only a short tail of resolved outcomes for presentation.
        foreach (var stale in resolved.Take(Math.Max(0, resolved.Length - RetainedResolved)))
            items.Remove(stale);
    }

    /// <summary>Validates model arguments and returns the stored question list.</summary>
    internal static JsonArray ParseQuestions(JsonNode? node)
    {
        if (node is not JsonArray array || array.Count is < 1 or > MaxQuestions)
            throw new InvalidDataException(
                $"questions must be an array of 1 to {MaxQuestions} questions."
            );
        var result = new JsonArray();
        foreach (var (entry, index) in array.Select((entry, index) => (entry, index)))
        {
            var label = $"questions[{index}]";
            if (entry is not JsonObject question)
                throw new InvalidDataException($"{label} must be an object.");
            if (question.Any(pair => pair.Key is not ("question" or "options" or "multiSelect")))
                throw new InvalidDataException(
                    $"{label} accepts only question, options and multiSelect."
                );
            var text = RequiredText(question["question"], $"{label}.question", MaxQuestionLength);
            var stored = new JsonObject { ["question"] = text };
            if (question.ContainsKey("options"))
            {
                if (question["options"] is not JsonArray options || options.Count > MaxOptions)
                    throw new InvalidDataException(
                        $"{label}.options must be an array of at most {MaxOptions} options."
                    );
                var parsed = new JsonArray();
                var labels = new HashSet<string>(StringComparer.Ordinal);
                foreach (var (raw, optionIndex) in options.Select((raw, i) => (raw, i)))
                {
                    var optionLabel = $"{label}.options[{optionIndex}]";
                    if (raw is not JsonObject option)
                        throw new InvalidDataException($"{optionLabel} must be an object.");
                    if (
                        option.Any(pair =>
                            pair.Key is not ("label" or "description" or "recommended")
                        )
                    )
                        throw new InvalidDataException(
                            $"{optionLabel} accepts only label, description and recommended."
                        );
                    var name = RequiredText(
                        option["label"],
                        $"{optionLabel}.label",
                        MaxLabelLength
                    );
                    if (!labels.Add(name))
                        throw new InvalidDataException(
                            $"{label}.options contains the label '{name}' more than once."
                        );
                    var storedOption = new JsonObject { ["label"] = name };
                    if (option.ContainsKey("description"))
                    {
                        var description = OptionalText(
                            option["description"],
                            $"{optionLabel}.description",
                            MaxDescriptionLength
                        );
                        if (description is not null)
                            storedOption["description"] = description;
                    }
                    if (option.ContainsKey("recommended"))
                    {
                        if (Bool(option["recommended"]) is not bool recommended)
                            throw new InvalidDataException(
                                $"{optionLabel}.recommended must be a boolean."
                            );
                        if (recommended)
                            storedOption["recommended"] = true;
                    }
                    parsed.Add(storedOption);
                }
                if (parsed.Count > 0)
                    stored["options"] = parsed;
            }
            if (question.ContainsKey("multiSelect"))
            {
                if (Bool(question["multiSelect"]) is not bool multi)
                    throw new InvalidDataException($"{label}.multiSelect must be a boolean.");
                if (multi)
                    stored["multiSelect"] = true;
            }
            result.Add(stored);
        }
        return result;
    }

    internal static JsonObject Add(
        JsonObject meta,
        string id,
        JsonArray questions,
        string? toolCallId,
        bool waiting
    )
    {
        if (Open(meta).Length >= MaxOpen)
            throw new InvalidOperationException(
                $"This Session already has {MaxOpen} open questions. Close questions that are no longer needed first."
            );
        var record = new JsonObject
        {
            ["id"] = id,
            ["status"] = "open",
            ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["questions"] = questions.DeepClone(),
        };
        if (!string.IsNullOrEmpty(toolCallId))
            record["toolCallId"] = toolCallId;
        if (waiting)
            record["afterAsk"] = "wait";
        Container(meta)["items"]!.AsArray().Add(record);
        Touch(meta);
        return record;
    }

    /// <summary>Moves one open question to a final state; returns false when it was not open.</summary>
    internal static bool Resolve(
        JsonObject meta,
        string id,
        string status,
        JsonObject? answer = null,
        string? closeNote = null
    )
    {
        var record = Find(meta, id);
        if (record is null || Status(record) != "open")
            return false;
        record["status"] = status;
        record["resolvedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (answer is not null)
            record["answer"] = answer.DeepClone();
        if (!string.IsNullOrWhiteSpace(closeNote))
            record["closeNote"] = closeNote.Trim();
        Touch(meta);
        return true;
    }

    internal static string NotOpenMessage(JsonObject meta, string id) =>
        Find(meta, id) is { } record
            ? $"Question {id} is no longer open; it was {Status(record)}."
            : $"Question {id} does not exist in this Session.";

    /// <summary>Bounded list/catalog projection: open count, waiting flag and change revision.</summary>
    internal static JsonObject? Projection(JsonObject meta)
    {
        if (meta["questions"] is not JsonObject)
            return null;
        var open = Open(meta);
        var waited = SessionWait.Strings(SessionWait.Current(meta)?["waitQuestionIds"]);
        var result = new JsonObject { ["open"] = open.Length, ["revision"] = Revision(meta) };
        if (open.Any(record => waited.Contains(SessionWait.Text(record["id"]))))
            result["waiting"] = true;
        return result;
    }

    // ---- Admission -------------------------------------------------------------------

    internal static bool IsUserInput(QueueItem item) =>
        item.Type == QueueItemType.User
        && item.OpenFields?["userInput"] is JsonValue flag
        && flag.TryGetValue<bool>(out var value)
        && value;

    internal static string? StructuredAnswerId(QueueItem item) =>
        item.OpenFields?["questionAnswer"] is JsonObject answer
        && SessionWait.Text(answer["questionId"]) is { } id
            ? id
            : null;

    /// <summary>
    /// Applies question effects of one admitted item before the ordinary wait transition.
    /// A structured answer must still find its question open (first answer wins); an ordinary
    /// user message answers the questions the current wait names.
    /// </summary>
    internal static QueueItem ApplyAdmission(
        JsonObject meta,
        QueueItem item,
        bool structured = true
    )
    {
        if (StructuredAnswerId(item) is { } id)
        {
            if (!structured)
                return item;
            var answer = (JsonObject)item.OpenFields!["questionAnswer"]!.DeepClone();
            var status = SessionWait.Text(answer["status"]) == "skipped" ? "skipped" : "answered";
            answer.Remove("questionId");
            answer.Remove("status");
            answer.Remove("questions");
            if (!Resolve(meta, id, status, answer))
                throw new QuestionNotOpenException(NotOpenMessage(meta, id));
            return item;
        }
        if (!IsUserInput(item) || !item.Trigger)
            return item;
        if (item.OpenFields?["questionAnswer"] is not null)
            return item;
        var waited = SessionWait.Strings(SessionWait.Current(meta)?["waitQuestionIds"]);
        if (waited.Length == 0)
            return item;
        var answered = new List<string>();
        var text = Bound(PlainText(item.Parts ?? []), MaxAnswerTextLength);
        foreach (var questionId in waited)
            if (
                Resolve(
                    meta,
                    questionId,
                    "answered",
                    new JsonObject { ["text"] = text, ["viaMessage"] = true }
                )
            )
                answered.Add(questionId);
        if (answered.Count == 0)
            return item;
        var fields = item.OpenFields is null
            ? new JsonObject()
            : (JsonObject)item.OpenFields.DeepClone();
        fields["questionAnswer"] = new JsonObject
        {
            ["questionIds"] = new JsonArray(
                answered.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["status"] = "answered",
            ["viaMessage"] = true,
        };
        var ids = string.Join(", ", answered);
        var parts = (item.Parts ?? [])
            .Select(part => (JsonObject)part.DeepClone())
            .Append(
                new JsonObject
                {
                    ["system"] =
                        "<foxwarm-system kind=\"question-answer\" questionIds=\""
                        + LocalSessionTurnHost.EscapeFoxwarmAttribute(ids)
                        + "\">\nThe user's message above answers "
                        + (answered.Count == 1 ? "question " : "questions ")
                        + ids
                        + ", which this Session was waiting on.\n</foxwarm-system>",
                }
            )
            .ToArray();
        return item with { Parts = parts, OpenFields = fields };
    }

    /// <summary>Visible user text of channel-wrapped input parts, without Foxwarm wrappers.</summary>
    internal static string PlainText(IReadOnlyList<JsonObject> parts)
    {
        var builder = new StringBuilder();
        foreach (var part in parts)
        {
            var text = SessionWait.Text(part["text"]);
            if (text is null && SessionWait.Text(part["system"]) is { } system)
            {
                var trimmed = system.Trim();
                if (Regex.IsMatch(trimmed, @"^<foxwarm-[a-zA-Z-]+\b[^>]*/>$"))
                    continue;
                text = Regex.Replace(trimmed, @"^<foxwarm-[a-zA-Z-]+\b[^>]*>\n?", "");
                text = Regex.Replace(text, @"\n?</foxwarm-[a-zA-Z-]+>$", "");
                if (text.Trim().Length == 0)
                    continue;
            }
            if (text is null)
                continue;
            if (builder.Length > 0)
                builder.Append('\n');
            builder.Append(text);
        }
        return builder.ToString().Trim();
    }

    // ---- Answer input -----------------------------------------------------------------

    /// <summary>
    /// Validates a WebUI answer against the question record and returns the stored answer.
    /// `answers[i]` pairs with `questions[i]`: selected option labels and/or free text.
    /// </summary>
    internal static JsonObject ParseAnswer(JsonObject record, JsonObject body)
    {
        if (body.Any(pair => pair.Key is not ("answers" or "note" or "skip")))
            throw new InvalidDataException("Answer accepts only answers, note and skip.");
        var questions = record["questions"]!.AsArray().OfType<JsonObject>().ToArray();
        if (body.ContainsKey("skip") && Bool(body["skip"]) is null)
            throw new InvalidDataException("skip must be a boolean.");
        var skip = Bool(body["skip"]) == true;
        var note = body.ContainsKey("note")
            ? OptionalText(body["note"], "note", MaxNoteLength)
            : null;
        var result = new JsonObject { ["status"] = skip ? "skipped" : "answered" };
        if (note is not null)
            result["note"] = note;
        if (skip)
        {
            if (body.ContainsKey("answers"))
                throw new InvalidDataException("A skipped question has no answers.");
            return result;
        }
        if (body["answers"] is not JsonArray answers || answers.Count != questions.Length)
            throw new InvalidDataException(
                $"answers must contain one entry for each of the {questions.Length} questions."
            );
        var stored = new JsonArray();
        var any = false;
        for (var index = 0; index < questions.Length; index++)
        {
            if (answers[index] is not JsonObject answer)
                throw new InvalidDataException($"answers[{index}] must be an object.");
            if (answer.Any(pair => pair.Key is not ("selected" or "text")))
                throw new InvalidDataException($"answers[{index}] accepts only selected and text.");
            var labels = questions[index]["options"] is JsonArray options
                ? options
                    .OfType<JsonObject>()
                    .Select(option => SessionWait.Text(option["label"])!)
                    .ToArray()
                : [];
            string?[] selected = answer.ContainsKey("selected")
                ? answer["selected"] is JsonArray chosen
                    ? chosen.Select(SessionWait.Text).ToArray()
                    : throw new InvalidDataException(
                        $"answers[{index}].selected must be an array of option labels."
                    )
                : [];
            if (selected.Any(label => label is null || !labels.Contains(label)))
                throw new InvalidDataException(
                    $"answers[{index}].selected contains an unknown option."
                );
            if (selected.Distinct(StringComparer.Ordinal).Count() != selected.Length)
                throw new InvalidDataException(
                    $"answers[{index}].selected contains an option more than once."
                );
            if (selected.Length > 1 && questions[index]["multiSelect"]?.GetValue<bool>() != true)
                throw new InvalidDataException($"Question {index + 1} accepts only one option.");
            var text = answer.ContainsKey("text")
                ? OptionalText(answer["text"], $"answers[{index}].text", MaxAnswerTextLength)
                : null;
            var entry = new JsonObject();
            if (selected.Length > 0)
                entry["selected"] = new JsonArray(
                    selected.Select(label => (JsonNode?)JsonValue.Create(label)).ToArray()
                );
            if (text is not null)
                entry["text"] = text;
            any |= entry.Count > 0;
            stored.Add(entry);
        }
        if (!any)
            throw new InvalidDataException("Choose an option or write an answer, or skip.");
        result["answers"] = stored;
        return result;
    }

    /// <summary>Model-facing text of a WebUI answer that pairs each question with its answer.</summary>
    internal static string RenderAnswer(string id, JsonObject record, JsonObject answer)
    {
        var questions = record["questions"]!.AsArray().OfType<JsonObject>().ToArray();
        var builder = new StringBuilder();
        var note = SessionWait.Text(answer["note"]);
        if (SessionWait.Text(answer["status"]) == "skipped")
        {
            builder.Append("I skipped question ").Append(id).Append(" without answering.");
            if (note is not null)
                builder.Append("\nNote: ").Append(note);
            return builder.ToString();
        }
        builder.Append("Answer to question ").Append(id).Append(':');
        var answers = answer["answers"]?.AsArray().OfType<JsonObject>().ToArray() ?? [];
        for (var index = 0; index < questions.Length; index++)
        {
            builder.Append("\n\n");
            if (questions.Length > 1)
                builder.Append(index + 1).Append(". ");
            builder.Append("Q: ").Append(SessionWait.Text(questions[index]["question"]));
            var entry = index < answers.Length ? answers[index] : null;
            var selected = SessionWait.Strings(entry?["selected"]);
            var text = SessionWait.Text(entry?["text"]);
            builder.Append("\nA: ");
            if (selected.Length == 0 && text is null)
                builder.Append("(no answer)");
            else
            {
                builder.Append(string.Join("; ", selected));
                if (text is not null)
                    builder.Append(selected.Length > 0 ? "; " : "").Append(text);
            }
        }
        if (note is not null)
            builder.Append("\n\nNote: ").Append(note);
        return builder.ToString();
    }

    /// <summary>Plain-text rendering for external channels, which have no answer card.</summary>
    internal static string ChannelText(JsonObject record)
    {
        var questions = record["questions"]!.AsArray().OfType<JsonObject>().ToArray();
        var builder = new StringBuilder();
        builder.Append(questions.Length == 1 ? "Question:" : "Questions:");
        for (var index = 0; index < questions.Length; index++)
        {
            builder.Append("\n\n");
            if (questions.Length > 1)
                builder.Append(index + 1).Append(". ");
            builder.Append(SessionWait.Text(questions[index]["question"]));
            if (questions[index]["options"] is not JsonArray options)
                continue;
            if (questions[index]["multiSelect"]?.GetValue<bool>() == true)
                builder.Append("\n(choose one or more)");
            foreach (
                var (option, optionIndex) in options
                    .OfType<JsonObject>()
                    .Select((option, i) => (option, i))
            )
            {
                builder
                    .Append('\n')
                    .Append(questions.Length > 1 ? "   " : "")
                    .Append(optionIndex + 1)
                    .Append(") ")
                    .Append(SessionWait.Text(option["label"]));
                if (option["recommended"]?.GetValue<bool>() == true)
                    builder.Append(" (recommended)");
                if (SessionWait.Text(option["description"]) is { } description)
                    builder.Append(" — ").Append(description);
            }
        }
        builder.Append("\n\nReply to answer.");
        return builder.ToString();
    }

    /// <summary>Request-only reminder listing open questions; null when none are open.</summary>
    internal static string? Reminder(JsonObject meta)
    {
        var open = Open(meta);
        if (open.Length == 0)
            return null;
        var waited = SessionWait.Strings(SessionWait.Current(meta)?["waitQuestionIds"]);
        var lines = open.Select(record =>
        {
            var id = SessionWait.Text(record["id"])!;
            var questions = record["questions"]!.AsArray().OfType<JsonObject>().ToArray();
            var summary = Bound(
                Regex.Replace(SessionWait.Text(questions[0]["question"]) ?? "", @"\s+", " ").Trim(),
                120
            );
            if (questions.Length > 1)
                summary += $" (+{questions.Length - 1} more)";
            return $"{id} — {summary} ({(waited.Contains(id) ? "waiting for the answer" : "not waited on")})";
        });
        return "<foxwarm-system kind=\"question-reminder\">Open questions to the user. Close any that are no longer needed or that the user already answered in conversation:\n"
            + string.Join('\n', lines)
            + "</foxwarm-system>";
    }

    // ---- Persisted validation -----------------------------------------------------------

    internal static void Validate(JsonObject meta)
    {
        if (!meta.ContainsKey("questions"))
            return;
        if (meta["questions"] is not JsonObject container)
            throw SessionAuthorityErrors.Invalid("Question state must be an object.");
        if (container["items"] is not JsonArray items)
            throw SessionAuthorityErrors.Invalid("Question state requires items.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in items)
        {
            if (
                node is not JsonObject record
                || SessionWait.Text(record["id"]) is not { Length: > 0 } id
                || !ids.Add(id)
                || !Statuses.Contains(SessionWait.Text(record["status"]))
                || record["questions"] is not JsonArray { Count: > 0 } questions
                || questions.Any(question =>
                    question is not JsonObject value || SessionWait.Text(value["question"]) is null
                )
            )
                throw SessionAuthorityErrors.Invalid("Invalid question record.");
        }
    }

    // ---- Helpers ----------------------------------------------------------------------

    private static string RequiredText(JsonNode? node, string label, int max) =>
        OptionalText(node, label, max) ?? throw new InvalidDataException($"{label} is required.");

    private static string? OptionalText(JsonNode? node, string label, int max)
    {
        if (node is null)
            return null;
        if (SessionWait.Text(node) is not { } text)
            throw new InvalidDataException($"{label} must be a string.");
        text = text.Trim();
        if (text.Length == 0)
            return null;
        if (text.Length > max)
            throw new InvalidDataException(
                $"{label} is longer than {max.ToString(CultureInfo.InvariantCulture)} characters."
            );
        return text;
    }

    private static bool? Bool(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<bool>(out var flag) ? flag : null;

    private static string Bound(string value, int max) =>
        value.Length > max ? value[..(max - 1)] + "…" : value;
}

internal sealed class QuestionNotOpenException(string message) : InvalidOperationException(message);
