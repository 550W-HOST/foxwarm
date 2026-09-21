---
title: FAQ
description: Resolve common setup, connection, and configuration problems.
---

## Is the documentation site a hosted Foxwarm service?

No. It hosts documentation and installer downloads. Install Foxwarm on your own machine or server to use the WebUI and run Agents.

## Where do I log in?

Use your installation's WebUI URL, not the documentation site. The startup URL includes the access token. See [Open the WebUI](/docs/installing/#open-the-webui) to recover it.

The WebUI token, Node pairing token, and external MCP identity tokens serve different purposes. Use the credential required by the interface you are connecting to.

## Why does Setup stay open?

The active data directory does not yet contain `state/models.yaml`. Complete [model setup](/docs/model-setup/) and save the configuration. If you expected an existing configuration, check that Foxwarm is using the intended data directory before creating a replacement.

## Models save successfully, but chat fails. What should I check?

Saving validates the configuration; it does not make a live model request. Check the provider type, API base URL, exact model ID, and credentials, then try a short text-only message. Only enable optional hosted tools after that works.

For endpoint-specific features, see [Model options and routing](/docs/model-options/). For connection errors, also inspect the instance's `state/logs/`.

## Why can Foxwarm not reach a service at localhost?

`localhost` refers to the environment making the request. Inside a container it means that container; on a remote Node it means that Node. Use an address reachable from the component that needs the service.

For a model service on the Docker host, `host.docker.internal` can be used where configured and supported. The repository's Compose setup includes a host-gateway mapping for it. The service must also listen on an address accessible from the container.

## I saved Config. Do I need to restart?

Saving **Setup → Config** refreshes managed Channels. Startup settings such as the HTTP port, Node providers, Vector search, and MCP inbound configuration require a Foxwarm restart.

For Docker Compose, changing the application port also requires matching changes to the port mapping and healthcheck. See [Docker Compose installation](/docs/installing/#docker-compose).

## A Channel connects, but messages do not reach my Session. Why?

Check the sender's platform ID against `allowedUsers`, then inspect the conversation's Session attachment. The bot's credentials, sender permissions, and conversation routing are separate checks. The [Channels guide](/docs/channels/#check-a-connection) covers the sequence.

## Where should I report a problem?

Use the repository's [issue tracker](https://github.com/550W-HOST/foxwarm/issues). Include the Foxwarm commit, platform, install method, relevant error, and steps to reproduce. Remove tokens, API keys, private messages, and sensitive paths from logs before sharing them.
