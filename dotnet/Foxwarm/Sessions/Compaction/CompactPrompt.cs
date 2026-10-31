using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Ordinary requests and dedicated planning expose the same tool definition.
internal static partial class CompactPrompt
{
    public static JsonObject ToolDefinition() =>
        JsonNode
            .Parse(
                """
                {
                  "type":"function",
                  "name":"submit_compact_plan",
                  "description":"Submit a plan to summarize older context into blocks and, where needed, remove previously preserved messages from active context. For a dedicated compaction request, use its supplied candidate ranges. Supply direct plan fields or argsFilePath, not both. Items not covered by the plan remain unchanged.",
                  "parameters":{
                    "type":"object",
                    "properties":{
                      "argsFilePath":{"type":"string","description":"Read a JSON compaction plan from this file instead of direct plan fields."},
                      "replaceAsBlocks":{
                        "description":"Blocks to create from continuous candidate ranges. Supply an array, or a JSON string encoding the same array. Use an empty array when only removing previously preserved messages.",
                        "oneOf":[
                          {"type":"array","items":{
                            "type":"object",
                            "properties":{
                              "level":{"type":"integer","minimum":1,"description":"Level of the new block: 1 for raw messages, or one above the source blocks."},
                              "sourceKind":{"type":"string","enum":["message","block"],"description":"Whether this range contains raw messages or existing blocks."},
                              "sourceStart":{"type":"integer","minimum":1,"description":"First message sequence number or block ID in the candidate range."},
                              "sourceEnd":{"type":"integer","minimum":1,"description":"Last message sequence number or block ID in the range, following its displayed history order."},
                              "summary":{"type":"string","description":"Summary of this range, retaining what is needed to continue the work."},
                              "frictionScore":{"type":"integer","minimum":0,"maximum":100,"description":"Estimated execution friction in this range, as an integer from 0 (none observed) to 100 (severe or repeated friction). Flags possible workflow, skills, memory, or framework improvements; not task difficulty, a probability, or an established diagnosis."},
                              "memoryFacts":{"type":"array","description":"Durable facts supported by this range. Invalid fact entries are skipped.","items":{
                                "type":"object","properties":{
                                  "kind":{"type":"string","enum":["decision","preference","fact","convention","environment"]},
                                  "text":{"type":"string"},"context":{"type":"string"},
                                  "attributedTo":{"type":"string","enum":["user","assistant","both"]}
                                },"required":["kind","text"],"additionalProperties":false
                              }}
                            },
                            "required":["level","sourceKind","sourceStart","sourceEnd","summary"],"additionalProperties":false
                          }},
                          {"type":"string","description":"JSON string encoding the same array of replacement blocks."}
                        ]
                      },
                      "preserveMessages":{"type":"array","items":{"type":"number"},"description":"Raw message sequence numbers to keep verbatim within summarized ranges. Selecting any part of a tool exchange also keeps its paired call and responses."},
                      "removePreservedMessages":{"type":"array","items":{"type":"number"},"description":"Previously preserved message sequence numbers to remove from active context. List every member when removing a preserved tool exchange. Archive records and summary blocks are not deleted."}
                    }
                  },
                  "strict":false
                }
                """
            )!
            .AsObject();

    public static string InvalidPlan(string reason) =>
        string.Join(
            ' ',
            "COMPACT PLAN INVALID.",
            reason,
            "Use only ranges shown in one Segment header; do not cross segment boundaries, different block levels, or different source kinds. Block ids may be non-consecutive or decreasing; use only listed B# endpoints in history order.",
            "Use preserveMessages only for raw messages covered by a newly created message-source block; use removePreservedMessages only for messages listed as previously preserved in the prompt.",
            "Fix only the layered-context plan and call submit_compact_plan again. Do not read or write agent memory during compaction; attach durable facts to the matching replaceAsBlocks entry's memoryFacts instead."
        );

    public static string InvalidTool(string? wrongName, int count, bool repairPending = false)
    {
        var notice =
            count == 0
                ? "Compact planning must be submitted by calling submit_compact_plan; plain text/no tool call cannot complete compaction."
            : wrongName is null or "submit_compact_plan"
                ? "Call submit_compact_plan exactly once, by itself."
            : $"Do not call `{wrongName}`; {(repairPending ? "only an exact-file edit repair, or a single plan submission, is accepted" : "the only accepted tool call during compaction is submit_compact_plan")}.";
        return string.Join(
            ' ',
            "COMPACT TOOL CALL INVALID.",
            notice,
            "Do not read or write agent memory during compaction.",
            "When ready, call exactly one submit_compact_plan tool call by itself. Do not combine submit_compact_plan with any other tool call."
        );
    }
}
