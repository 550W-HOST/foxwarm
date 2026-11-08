---
title: Webhooks
description: Let GitHub, Cloudflare and monitoring tools notify a Session when something happens.
---

A webhook lets an external service tell Foxwarm about an event as it happens: a CI run failed, a pull request was opened, a site went down. Each webhook delivers into one Session that you choose. Either the agent there sees the delivery as data from that service and decides what to do with it, or a script you configure handles it without involving the agent.

Compared with a [timer](/docs/timers/) that checks a service every few minutes, a webhook reacts within seconds and makes no requests while nothing is happening.

## Before you start

The sending service must reach Foxwarm over the internet, usually through HTTPS on a reverse proxy or tunnel. Set `url` in `state/config.yaml` to that public address so Foxwarm shows the right webhook addresses. A Foxwarm instance that is only reachable on your local network cannot receive webhooks from cloud services; use a timer instead.

Create a long random secret for each webhook, for example:

```sh
openssl rand -hex 32
```

## Add a webhook

Each webhook is an identity in `state/config.yaml` with only the `webhook` surface. Save the change through **Setup → Config**; it applies without a restart.

```yaml
access:
  identities:
    github-ci:
      token: REPLACE_WITH_THE_SECRET_YOU_GAVE_GITHUB
      surfaces:
        webhook:
          session: ops/main
          verify: github
          events: [workflow_run, pull_request]
    cloudflare-alerts:
      token: REPLACE_WITH_THE_CLOUDFLARE_SECRET
      surfaces:
        webhook:
          session: ops/main
          verify: { header: cf-webhook-auth }
    uptime:
      token: REPLACE_WITH_A_LONG_PRIVATE_TOKEN
      surfaces:
        webhook:
          session: ops/main
          verify: bearer
```

| Field | Meaning |
| --- | --- |
| identity name | Part of the webhook address. Letters, digits, `.`, `_` and `-`. |
| `token` | The shared secret. Use it for nothing else. |
| `session` | The existing Session that receives every delivery. Renamed Sessions keep working; a missing Session is never created. |
| `verify` | How the sender proves it knows the secret (below). |
| `events` | Optional, GitHub only: the event types to deliver. Others are acknowledged and dropped. |
| `action` | Optional: `message` (default) delivers to the agent; `toolscript` runs `script` instead. See [Choose what happens](#choose-what-happens). |
| `wake` | Optional, `message` only: `false` delivers without starting the agent. |
| `script` | Required for `toolscript`: the script that handles each delivery. |

The address of each webhook is `<your url>/webhooks/<identity name>`, for example `https://foxwarm.example.com/webhooks/github-ci`.

A webhook identity cannot also sign in to the WebUI or call the MCP endpoint, because its secret is shared with another service.

### Verification methods

| `verify` | Used by | What Foxwarm checks |
| --- | --- | --- |
| `github` | GitHub repository, organization and GitHub App webhooks | The `X-Hub-Signature-256` signature of the request body. The secret itself is never sent. |
| `{ header: <name> }` | Cloudflare (`cf-webhook-auth`), GitLab (`X-Gitlab-Token`) and similar | The named header contains exactly the secret. |
| `bearer` | Your own scripts and monitoring tools | `Authorization: Bearer <secret>`. |

## Choose what happens

By default each delivery starts the agent in the target Session, or joins its current work if it is busy. Two options change that.

### Deliver without waking the agent

Some events are worth knowing about but not worth a model turn each, such as pushes or new issues on a busy repository. With `wake: false`, deliveries are saved to the Session without starting the agent. It reads them, in order, the next time it works for another reason: your message, a timer or another webhook.

```yaml
    github-activity:
      token: REPLACE_WITH_THE_SECRET_YOU_GAVE_GITHUB
      surfaces:
        webhook:
          session: ops/main
          verify: github
          events: [push, issues]
          wake: false
```

### Handle deliveries with a script

With `action: toolscript`, each delivery runs a [ToolScript](/docs/tools-skills-mcp/#combine-calls-with-toolscript) instead of reaching the agent. The script runs for the target Session with that Session's tools and permissions and starts no model turn, like a [timer script](/docs/timers/#scripts-without-a-model-turn). A typical handler checks the payload and sends the Session a message only when something needs attention, for example when a CI run on the main branch failed. Ask the agent to write the script.

```yaml
    github-ci:
      token: REPLACE_WITH_THE_SECRET_YOU_GAVE_GITHUB
      surfaces:
        webhook:
          session: ops/main
          verify: github
          events: [workflow_run]
          action: toolscript
          script:
            filePath: hooks/ci-failures.py
            args: { branch: main }
            timeoutSecs: 60
```

`script` takes `code` or `filePath`, and optionally `node` (where to read `filePath` from), `args` and `timeoutSecs`. A script file is read again for every delivery, so changes apply to the next one. Your `args` are passed unchanged, and `args['webhook']` describes the delivery:

| Key | Value |
| --- | --- |
| `id` | The webhook's identity name. |
| `event`, `action`, `deliveryId` | For GitHub: the event name, the payload's `action`, and the delivery ID. Otherwise `None`. |
| `receivedAt` | When Foxwarm received the delivery, as an ISO 8601 UTC time. |
| `contentType` | The body's media type, such as `application/json`. |
| `payload` | The body: the parsed value for JSON, otherwise the text. |

Deliveries to one webhook are handled one at a time, in order; up to 32 can wait. Foxwarm answers `202` once a delivery is queued, so the sender does not learn whether the script succeeded. Check the result in **System → Webhooks**. Deliveries still waiting when Foxwarm stops are not run. A GitHub delivery whose script failed can be redelivered from GitHub to run it again.

## Connect GitHub

In the repository's **Settings → Webhooks → Add webhook**:

- **Payload URL:** the webhook address.
- **Content type:** `application/json`.
- **Secret:** the identity's `token`.
- **Events:** only the events you need. You can narrow them further with `events` in Foxwarm.

GitHub sends a `ping` when you save; Foxwarm acknowledges it without bothering the agent. A redelivered event is accepted once.

GitHub does not retry a delivery that failed, for example while Foxwarm was restarting. You can redeliver recent deliveries from the webhook's **Recent Deliveries** page. If a missed event matters, keep an infrequent timer that checks for anything the webhook missed.

## Connect Cloudflare

In **Notifications → Destinations → Webhooks**, create a webhook with the webhook address as URL and the identity's `token` as secret, then select that destination in your notification policies. Use `verify: { header: cf-webhook-auth }`.

## Check deliveries

**System → Webhooks** lists every webhook with its address, the Session it delivers to and what arrived recently: delivered, ignored and duplicate deliveries, rejected requests, script results with a link to each run, and how many requests had a wrong secret or signature. It also warns when the target Session does not exist. To test a new GitHub webhook, save it in GitHub and look for its `ping`. The list covers deliveries since Foxwarm last started.

## Call it from your own tools

```sh
curl -X POST https://foxwarm.example.com/webhooks/uptime \
  -H "Authorization: Bearer $UPTIME_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"monitor": "api", "status": "down"}'
```

The body can be JSON or plain UTF-8 text, up to 1 MiB.

## What the agent receives

Unless the webhook runs a script, each delivery arrives in the Session as one input marked as coming from that webhook, with the event name for GitHub. The agent sees the body as it was sent, up to the first 64 KiB, with a note when the rest was cut off. If the Session is busy, deliveries wait and are read together when it is free.

A delivery gives the sender no permissions in Foxwarm. Whatever the agent does in response, it does with its own Agent's tools and rules.

Treat delivered text like any text from the outside world. On a public repository, titles, comments and branch names come from anyone who can open a pull request, and some of it may be written to mislead the agent. Send such events to a Session whose Agent has only the tools it needs; see [Access control](/docs/access-control/). Use `events` to keep noisy event types out.

## Responses

| Status | Meaning |
| --- | --- |
| `202` | Accepted and saved to the Session, or queued for the webhook's script. |
| `200` | Acknowledged without delivery: a GitHub `ping`, an event not listed in `events`, or a delivery already accepted. |
| `401` | Unknown webhook or wrong secret or signature. |
| `413` | The body is larger than 1 MiB. |
| `415` | The body is not JSON or UTF-8 text. |
| `429` | Too many deliveries from this webhook (more than 60 at once, then 10 a minute), or 32 already waiting for its script. Retry after the time given in `Retry-After`. |
| `503` | The target Session is unavailable or Foxwarm is shutting down. |

## Replacing `/trigger`

The administrator-only `POST /trigger` endpoint is deprecated and will be removed in a later release. Responses from it carry a `Deprecation` header. To move a script off it, add a `bearer` webhook for the Session it used and send the message text as the body.
