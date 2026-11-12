# Unit: webui-session-question-hint

Files: packages/webui/src/components/SessionListQuestionHint.tsx, packages/webui/src/sessionQuestionHint.ts, packages/webui/test/sessionQuestionHint.test.mjs, packages/webui/test/sessionListQuestionHint.e2e.mjs
Secondary files: packages/webui/src/components/SessionListCore.tsx, packages/webui/src/index.css

## Purpose

Leads back to the Session list's `Needs your answer` section ([session list](./webui-session-list.md#behavior), [structured user questions](./session-questions.md)) once the user has scrolled it out of view. `SessionListCore` renders the hint over its scroll container and passes the scroll container, the rendered section and the section's Session count; the section itself, its membership and order stay owned by the list.

## Function Index

| Function | File | Description |
|----------|------|-------------|
| `getQuestionSectionPlacement(section, visibleTop)` | sessionQuestionHint.ts | `none` without a rendered section, otherwise `out` when less than `QUESTION_SECTION_MIN_VISIBLE_PX` of it remains below the visible top, else `in-view` |
| `shouldShowQuestionHint(count, placement)` | sessionQuestionHint.ts | Shown only for a positive count with the section out of view |
| `questionHintLabel(count)` | sessionQuestionHint.ts | Singular/plural visible label |
| `nextQuestionHintAnnouncement(baseline, count, placement)` | sessionQuestionHint.ts | Whether a count change is announced; `baseline` is the count the user was last shown |
| `SessionListQuestionHint` | SessionListQuestionHint.tsx | Measures placement on scroll and resize, renders the floating button and the status region, scrolls back and moves focus |

## Design Decisions

### D-session-list-question-hint

[2026-11-12] User decision, chosen over a sticky section or a fixed area outside the list. The `Needs your answer` section keeps scrolling with the list. While it is scrolled out of view, a small hint button floats at the top of the list's scroll area with the number of Sessions in the section (`1 session waiting for your answer`, `N sessions waiting for your answer`). Activating it scrolls the list to the top, smoothly unless reduced motion is requested. It disappears when the section is visible again or no Session has an open question, and follows questions opening and closing live. The hint must not cover the list's own header controls.

Implementation choices (2026-11-12, within that decision):

- Activation also moves focus to the section, which is focusable only programmatically, so keyboard focus is not lost when the button disappears.
- The section counts as out of view when less than 12px of it remains below the visible top of the list: the scroll container's content top, which on the mobile Sessions page is below the overlaying page header. A thinner sliver shows no readable row.
- The hint is absent while the section is in view, when no Session has an open question, and whenever the section is not rendered, including a search that matches none of those Sessions; with matching ones it counts them. It follows open questions live through the same rows as the section. The collapsed rail has no question section and no hint.
- It overlays the scroll container from a wrapper (`SessionListQuestionHint`, `data-session-question-hint=<count>`), so it never changes row positions or the scroll area's size, and it stays below the list toolbar or the mobile header. It is a real button placed before the rows in focus order.
- A persistent visually hidden `role="status"` region (`data-session-question-hint-status`) announces the count only when it changes while the section is out of view, including the hint appearing for a newly opened question. Scrolling alone and the hint disappearing announce nothing.
- `sessionListQuestionHint.e2e.mjs` covers appearance after scrolling, the sliver threshold, geometry, live count and announcement, click and keyboard return with focus, reduced motion, the last question closing, a question opening while scrolled, Default/Time/Flat and Agent groups, a filtered list without the section and the mobile page; with `FOXWARM_E2E_SCREENSHOT_DIR` it captures light and dark desktop and mobile screenshots.
