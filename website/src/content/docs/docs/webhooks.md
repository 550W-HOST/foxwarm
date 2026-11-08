---
title: Webhooks
description: Let GitHub, Cloudflare and monitoring tools notify a Session when something happens.
---

A webhook lets an external service tell Foxwarm about an event as it happens: a CI run failed, a pull request was opened, a site went down. Each webhook delivers into one Session that you choose. The agent there sees the delivery as data from that service and decides what to do with it.

Compared with a [timer](/docs/timers/) that checks a service every few minutes, a webhook reacts within seconds and makes no requests while nothing is happening.

## Before you start

The sending service must reach Foxwarm over the internet, usually through HTTPS on a reverse proxy or tunnel. Set `url` in `state/config.yaml` to that public address so Foxwarm shows the right links. A Foxwarm instance that is only reachable on your local network cannot receive webhooks from cloud services; use a timer instead.

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

The address of each webhook is `<your url>/webhooks/<identity name>`, for example `https://foxwarm.example.com/webhooks/github-ci`.

A webhook identity cannot also sign in to the WebUI or call the MCP endpoint, because its secret is shared with another service.

### Verification methods

| `verify` | Used by | What Foxwarm checks |
| --- | --- | --- |
| `github` | GitHub repository, organization and GitHub App webhooks | The `X-Hub-Signature-256` signature of the request body. The secret itself is never sent. |
| `{ header: <name> }` | Cloudflare (`cf-webhook-auth`), GitLab (`X-Gitlab-Token`) and similar | The named header contains exactly the secret. |
| `bearer` | Your own scripts and monitoring tools | `Authorization: Bearer <secret>`. |

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

## Call it from your own tools

```sh
curl -X POST https://foxwarm.example.com/webhooks/uptime \
  -H "Authorization: Bearer $UPTIME_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"monitor": "api", "status": "down"}'
```

The body can be JSON or plain UTF-8 text, up to 1 MiB.

## What the agent receives

Each delivery arrives in the Session as one input marked as coming from that webhook, with the event name for GitHub. The agent sees the body as it was sent, up to the first 64 KiB, with a note when the rest was cut off. If the Session is busy, deliveries wait and are read together when it is free.

A delivery gives the sender no permissions in Foxwarm. Whatever the agent does in response, it does with its own Agent's tools and rules.

Treat delivered text like any text from the outside world. On a public repository, titles, comments and branch names come from anyone who can open a pull request, and some of it may be written to mislead the agent. Send such events to a Session whose Agent has only the tools it needs; see [Access control](/docs/access-control/). Use `events` to keep noisy event types out.

## Responses

| Status | Meaning |
| --- | --- |
| `202` | Accepted and saved to the Session. |
| `200` | Acknowledged without delivery: a GitHub `ping`, an event not listed in `events`, or a delivery already accepted. |
| `401` | Unknown webhook or wrong secret or signature. |
| `413` | The body is larger than 1 MiB. |
| `415` | The body is not JSON or UTF-8 text. |
| `429` | Too many deliveries from this webhook (more than 60 at once, then 10 a minute). Retry after the time given in `Retry-After`. |
| `503` | The target Session is unavailable or Foxwarm is shutting down. |

## Replacing `/trigger`

The administrator-only `POST /trigger` endpoint is deprecated and will be removed in a later release. Responses from it carry a `Deprecation` header. To move a script off it, add a `bearer` webhook for the Session it used and send the message text as the body.
