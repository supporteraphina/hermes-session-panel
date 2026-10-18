# Session panel for Hermes Desktop

A list button in the top right of Hermes Desktop that opens a panel beside the chat with:

- **Agents**: Hermes itself, helper agents it started and background jobs
- **Environment**: backend, working folder, git repo and branch
- **Context**: how full the context window is, split by category
- **Connectors**: MCP servers and connected apps
- **Outputs**: files the chat delivered (click to copy the path)
- **Changes**: uncommitted work in the folder and the pull requests the chat opened (click to open)

It sits next to the VPS browser and the app's own right sidebar, so all three can be open together. Drag its edge to resize; the app remembers the width.

## Install

Open on the computer that runs Hermes Desktop:

`hermes://plugin/install?repo=supporteraphina/hermes-session-panel/session-panel&force=1`

Then turn it on in Capabilities → Plugins if it is off. Also in ⌘K as "Toggle session panel".

## How it works

The panel reads the focused chat through the gateway (`subagent.list`, `process.list`, `session.context_breakdown`, `config.get`, `connectors.list`, `session.info` events). `src/panel.py` is bundled into the plugin and written to `~/.hermes/session-panel/` on the backend on first load; it reads `state.db` read only for the chat's delivered files and pull request links, and asks `gh` for each pull request's state.

## Build

`npm install && npm run build` writes `session-panel/plugin.js`.
