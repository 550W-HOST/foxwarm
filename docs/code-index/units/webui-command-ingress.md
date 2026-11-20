# Unit: WebUI command ingress

Files: `packages/webui/src/commandIngress.ts`, `packages/webui/src/userCommandHeads.ts`, `packages/webui/test/commandIngress.test.mjs`, `packages/webui/test/slashIngress.e2e.mjs`

Secondary files: `packages/webui/src/components/useChatConversationSync.ts`, `packages/webui/build/ctlRegistry.ts`

`isKnownCommand` imports the [ctl registry](./ctl-command-registry.md) at build time and derives the user command heads the backend's `UserCommands` generates: `/help`, the shortcuts and every noun with a user-ingress command. The production bundle's slim registry carries those heads precomputed. It matches a complete, case-sensitive command head with JavaScript whitespace, equivalent to the backend's Source `CommandSpace` grammar. It requires neither administrator command discovery nor an asynchronous fetch. [Catalog classification](./dotnet-command-administration.md#d-slash-catalog-classification) owns the input rule.

The [chat send owner](./webui-chat.md) uses this predicate to omit optimistic history and `clientMessageId` only for known commands. Unknown slash text follows ordinary attachment upload, pending history or busy-queue preview, correlated POST and rejected-send cleanup, including restricted WebUI identities. Backend authorization remains authoritative. Recognized controls keep their separate correlated control request path.

The classifier tests enumerate every catalog entry and token boundaries. The browser fixture mounts the actual React synchronization hook, holds POST responses and checks pending rows against serialized request identities, uploads, idle/busy and administrator/restricted states, command/control sends and rejection cleanup. It uses synthetic network responses; actual scoped HTTP admission and Telegram polling are tested by `WebUiAccessTests`, `CommandAdministrationTests.SlashIngress.cs` and `TelegramChannelTests.SlashIngress.cs`.
