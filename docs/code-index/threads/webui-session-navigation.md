# Thread: WebUI Session navigation

## D-webui-prepared-session-navigation

[2026-10-17] Desktop Session selection prepares the selected target's bounded initial history before replacing the current Chat/preview. The previous pane stays visible and temporarily inert rather than being cleared into an empty Chat. Slow reads show a delayed compact Opening indicator; fast reads do not flash a loader. The target mounts with its initial messages and metadata already available, then follows normal reconciliation. Its short opacity settle is disabled by reduced motion.

Only explicit target navigation is prepared. There is no all-Session prefetch or persistent/unbounded Chat cache. A new choice or ordinary route/pane navigation cancels the prior intent; late responses cannot change the selected target. Failed preparation falls back to the normal Chat loading/error path. Existing visible kept Chats and the mobile navigation path preserve their ordinary behavior.

The handoff holds at most two entries for 30 seconds and bounds each parsed response. Active bootstrap reads retain the existing 100-message tail. Continuous mode separately prepares the latest 100 original Archive records, or at most one bounded page on either side of the saved canonical anchor. Active context never substitutes for original Archive rows. The mounted synchronization owner retains normal realtime version/frontier checks and performs one bounded Archive catch-up after subscription, including when the prepared active snapshot already matches live state. Prepared Archive rows are only a first-paint seed: catch-up reads later records from the loaded tail, merges concurrent live commits, and leaves any remaining newer pages for explicit paging rather than reloading or draining the Archive.

Preview IDs, draft lifetime, scroll restoration, permission checks, semantic unmounting, tab ancestry and Code/Terminal resource ownership are unchanged. This is a render handoff, not a second runtime subscriber or a backend execution trigger.

## Owners and checks

- [Navigation handoff](../units/webui-session-navigation.md) owns the bounded transient data.
- [App](../units/webui-app.md), [Chat synchronization](../units/webui-chat.md) and [content hosts](../units/webui-workbench-content.md) stage, seed and present one navigation intent.
- Actual built-App regressions stall history, require the old body to remain inert/visible, sample animation frames for a populated target, verify one bootstrap read, and prove the last click wins even if an abandoned server response ignores cancellation.
