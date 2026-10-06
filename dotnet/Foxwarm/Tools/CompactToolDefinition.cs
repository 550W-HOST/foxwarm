using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class CompactToolDefinition
{
    internal static JsonObject Definition() =>
        JsonNode
            .Parse(
                """
{
  "type": "function",
  "name": "compact_session",
  "description": "Start compaction for this session or another idle session. The target uses a separate planning turn to produce a summary plan with submit_compact_plan; this call does not return the candidates or supply the final summary.",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": {
      "sessionId": { "type": "string", "description": "Session to compact. Defaults to this session." },
      "summary": { "type": "string", "description": "Additional instructions for the compaction planner, not the final summary or plan." },
      "keepPercent": { "type": "number", "description": "Recent history to retain, as a fraction greater than 0 and up to 1, or a percentage greater than 1 and up to 100. Defaults to the configured retention fraction." }
    }
  }
}
"""
            )!
            .AsObject();
}
