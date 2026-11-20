# Export Main traces over OTLP

Add `otlp` to `state/config.yaml` and restart Main. The endpoint is the full OTLP/HTTP protobuf traces URL. Configure any collector credentials in Setup's secret store and reference them in request headers.

```yaml
otlp:
  endpoint: https://collector.example.com/v1/traces
  headers:
    Authorization: 'Bearer ${secret:otel-collector-token}'
  captureContent:
    reasoning: false
```

Omitting `otlp` or setting `otlp.enabled: false` disables export. Omit `headers` for a collector without authentication. The tracing configuration and header values are captured at startup. If a configured header secret is unavailable, Main starts with tracing disabled. Certificate validation follows the system trust store.

The existing `set_config` permission covers OTLP settings. An enabled destination receives the selected trace content from Sessions across the whole Main instance. Changes that introduce a header secret destination follow the existing secret authorization rules.

## What is exported

A `foxwarm.run` span describes a foreground Session turn. Model spans (`chat <model>` or `generate_content <model>`) describe concrete model attempts, including retry and failover. `execute_tool <name>` spans describe local, Node and MCP invocations and calls settled before dispatch. The trace carries the Session ID as `gen_ai.conversation.id`, with one root per turn. Independent Session model or tool work has its own trace. Setup’s Test Connection request is outside Session tracing. Span timestamps, status, `error.type` where available and `foxwarm.outcome` describe settlement. Traces appear as spans finish.

All `captureContent` switches default to `true` when tracing is enabled. Set any of the following to `false` in `otlp.captureContent`:

| Switch | Content |
|---|---|
| `systemPrompt` | System and developer instructions |
| `inputMessages` | Prepared model input and conversation history |
| `outputMessages` | Assistant output, including committed segments |
| `toolDefinitions` | Request tool definitions |
| `toolArguments` | Tool inputs, including arguments in captured messages |
| `toolResults` | Tool results, including responses in captured history |
| `reasoning` | Reasoning text in enabled input and output messages |

Set all seven to `false` for metadata-only export. Captured content can contain private conversation and tool data. Export adds no redaction of its own. Each content attribute is at most 16 KiB of UTF-8 JSON. Long history keeps the newest fitting records in chronological order. Large content may be shortened or omitted. Main batches spans in memory and allows up to five seconds to drain the telemetry queue at shutdown. A full queue drops spans.
