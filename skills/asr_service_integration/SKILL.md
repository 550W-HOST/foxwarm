---
name: asr_service_integration
description: Guide for connecting Foxwarm to a standalone ASR service through backend proxy routes and config.yaml.
---

# asr_service_integration

Use this skill when Foxwarm needs to enable speech transcription features in WebUI.

## Foxwarm config

Add ASR service config to `state/config.yaml`:

```yaml
asrService:
  enabled: true
  url: http://127.0.0.1:8091
  key: change-me
```

## Intended request flow

```text
Browser -> Foxwarm /api/asr/* -> standalone ASR service
```

This avoids exposing the ASR URL/key directly to the browser.

## Expected Foxwarm API surface

- `GET /api/asr/status`
- `POST /api/asr/transcribe`
- `WS /api/asr/stream`

## Validation checklist

1. Foxwarm backend can read `asrService.url/key`.
2. `/api/asr/status` returns configured+available when service is healthy.
3. File upload transcription works from WebUI.
4. Live recording preview works through WebSocket proxy.
5. Browser only talks to Foxwarm origin, not directly to the ASR host.

## Troubleshooting

- `401 Unauthorized`: key mismatch between Foxwarm config and ASR service env.
- `status unavailable`: bad ASR URL or service not started.
- live recording fails but file works: check websocket proxy path and auth.
- weird localhost/port-forward behavior: prefer same-origin `/api/asr/*` proxy instead of direct browser-to-ASR connections.