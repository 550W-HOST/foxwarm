# Export Main traces over OTLP

Add `otlp` to `state/config.yaml` and restart Main. The endpoint is the full OTLP/HTTP protobuf traces URL. Configure any collector credentials in Setup's secret store and reference them in request headers.

```yaml
otlp:
  endpoint: https://collector.example.com/v1/traces
  headers:
    Authorization: 'Bearer ${secret:otel-collector-token}'
```

Omitting `otlp` or setting `otlp.enabled: false` disables export. Omit `headers` for a collector without authentication. The tracing configuration and header values are captured at startup. If a configured header secret is unavailable, Main starts with tracing disabled. Certificate validation follows the system trust store.

The existing `set_config` permission covers OTLP settings. An enabled destination receives the selected trace content from Sessions across the whole Main instance. Changes that introduce a header secret destination follow the existing secret authorization rules.

## What is exported

A `foxwarm.run` span describes a foreground Session turn. Model spans (`chat <model>` or `generate_content <model>`) describe concrete model attempts, including retry and failover. `execute_tool <name>` spans describe local, Node and MCP invocations and calls settled before dispatch. The trace carries the Session ID as `gen_ai.conversation.id`, with one root per turn. Independent Session model or tool work has its own trace. Setup’s Test Connection request is outside Session tracing. Span timestamps, status, `error.type` where available and `foxwarm.outcome` describe settlement. Traces appear as spans finish.

An endpoint alone exports metadata. Model attempts carry `gen_ai.response.finish_reasons` when the provider reported a termination or tool call. When a journal entry exists, `foxwarm.journal.request.id` and `foxwarm.journal.attempt` identify the local request and attempt. The local journal remains the source for request history; a collector can drop spans.

## Opt in to content

Set individual `otlp.captureContent` switches to `true`. All seven default to `false`. They apply across the instance. Private conversation and tool data can reach the collector whenever the corresponding switch is on.

| Switch | Content |
|---|---|
| `systemPrompt` | System and developer instructions from the prepared request |
| `inputMessages` | Input messages as sent to the provider, newest first when selecting a bounded history |
| `outputMessages` | Assistant output from the provider, including committed segments, before any private placeholders are restored |
| `toolDefinitions` | Tool descriptions and parameters in the request |
| `toolArguments` | Arguments on authorized execution spans. Known secrets are masked; `add_secret.value`, executable wrapper bodies, and arguments without a safe provider representation are omitted. Message spans contain tool-call names and IDs only. |
| `toolResults` | Processed tool responses. For a text-redacted model, results are available in captured provider input when `inputMessages` is also on; the local execution result is omitted. |
| `reasoning` | Reasoning in selected input or output messages. Both message classes remain off unless explicitly enabled. |

Content is sampled from a bounded number of parts and limited to 16 KiB per attribute before SDK serialization. Large values and unrecognized parts can be shortened or omitted. Main batches spans in memory and allows up to five seconds to drain them at shutdown. A full queue drops spans.

## Process environment

- `OTEL_SDK_DISABLED=true` disables tracing even with a configured endpoint. Foxwarm allows the SDK's default retry behavior or `OTEL_DOTNET_EXPERIMENTAL_OTLP_RETRY=in_memory`. Disk retry or an unknown retry value disables export with a startup warning. Main never configures a trace spool.
- Foxwarm sets the endpoint, headers, HTTP/protobuf protocol, request timeout, batch settings, sampler and service identity. The SDK's corresponding `OTEL_EXPORTER_OTLP_*`, `OTEL_BSP_*`, `OTEL_TRACES_SAMPLER*`, `OTEL_RESOURCE_ATTRIBUTES`, and `OTEL_SERVICE_NAME` settings do not override these choices. Trace-specific exporter variables and SDK client-certificate settings are not applied by this transport.
- Generic `OTEL_EXPORTER_OTLP_COMPRESSION`, SDK attribute length/count limits, and SDK self-diagnostics still apply. A smaller SDK value-length limit can truncate a JSON attribute in transit. The HTTP client uses the system TLS trust and proxy settings.
