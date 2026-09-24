Adds `dsh-ask-notify` — a bottom-right reminder card for the DSH web GUI that fires whenever the agent is blocked waiting on a human answer (`ask_user_question`, approvals, plan review). When the page is not visible or not focused it also raises a desktop notification and flashes the tab title, so an agent that is stuck waiting stops being invisible to a user who switched tabs.

Data comes from the host's own session runtime state rather than DOM scraping, so it does not depend on page markup. The pending state has moved twice, so three sources are read in order: `uiSession.sessionStatus` (harness `0.1.7`+), `uiSession.pendingInteractions` (`0.1.2` … `0.1.6`), and `SessionSummary.pendingInteraction` on the session list (`<= 0.1.1-rc.x`) — the same state the amber dot in the sidebar is built from. A session that has no value in the newer source falls back to the next one, and if no source is readable at all the client half now says so on the console instead of failing silently. The client half makes no network requests at all — no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no URL constants. Preferences live in `localStorage` only.

- [x] I added **one file** at `data/plugins/liujianqiao701__dsh-ask-notify.yml` — that single file is the whole submission.
- [x] My repo's `package.json` declares **`dsh.bundle`** (not just `dsh.client`)
- [ ] My repo is at least **1 day old**
- [x] `category` is `notify`
- [x] Description states what the plugin does, no superlatives
- [x] My repo has the `dsh-plugin` topic

Notes for the reviewer:

- `package.json` declares `dsh.bundle.patch` → `./cordis.patch.yml`, and that patch carries the `insert` row (`id: ask-notify`) that mounts the plugin — standard for this catalog.
- The plugin is client-only by design; `lib/index.js` is a deliberate empty host-side entry (`inject = []`, `apply() {}`) and `lib/client.js` holds all the logic.
- Screenshots are served from this repository via a `screenshots.json` beside `package.json` (`assets/screenshot-1.png`, `assets/screenshot-2.png`), so nothing needs to be added to this pull request.
- No `dependencies` and no `peerDependencies`: the plugin uses no npm package of its own. `dsh.client.inject` is deliberately **empty** — that list names sibling client-module *packages*, and the one it used to name (`@deepseek-ai/dsh-client-runtime`) no longer ships in newer harnesses. (It never blocked mounting: the loader silently skips dependencies absent from the module graph — but it was a dead reference, so it is gone.) The real dependency is the `sessions` service, declared as `exports.inject`.
