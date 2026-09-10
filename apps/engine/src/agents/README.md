# Hosted agents

This directory contains the hosted-agent catalog, protocol adapters, model discovery, conversation history, and handoff services.

Use `/model` in Jolo or `jolo agent list` to inspect configured agents. Hosted CLIs must already be installed and authenticated separately. User JSON manifests belong under `agents/` in the profile data directory; `catalog.js` reads them at engine startup and `manifests.js` defines the built-in defaults.

Hosted programs run with the local user's privileges. Jolo mediates the operations exposed by their transports; it does not sandbox arbitrary programs at the operating-system level. See the [security policy](../../../../SECURITY.md) and [CLI guide](../../../cli/README.md).
