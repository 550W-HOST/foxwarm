# Unit: shared-session-presentation

Files: packages/shared/src/sessionNotice.ts, packages/shared/src/sessionControlFeedback.ts

## Purpose and exports

Bounded, closed-cloning metadata for system notices and command feedback. `SessionNotice` and `parseSessionNotice` define version-one event identity, source, severity, title, summary and optional diagnostics. `SessionControlFeedback`, `parseSessionControlFeedback`, and `getSessionControlAction` define supported WebUI control intents and accepted/no-op/error feedback.

Parsers accept unknown input, reject malformed fields without coercing objects into enum strings, drop unrelated properties and grant no authority. Control intent detection follows the existing command grammar: Continue/Dequeue ignore trailing arguments; compaction owns its existing argument parser; Stop accepts only its two supported forms.

The shared package index re-exports these contracts. Backend producers/transport and frontend consumers own their own lifecycle. Tests live in `src/sessionNotices.test.ts`; browser integration exercises the real consumer. Governing contract: [Session runtime presentation](../threads/session-runtime-presentation.md).
