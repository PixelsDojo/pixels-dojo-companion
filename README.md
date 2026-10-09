# Pixels Dojo Companion

**v0.3.2** — An AI companion for [Pixels Online](https://pixels.xyz) — instant answers, strategy advice, and live context-aware help, right inside the game.

> **Work in progress — feedback very welcome!**
> Share thoughts, bugs, or suggestions: [Feedback form](https://docs.google.com/forms/d/e/1FAIpQLScuYiSpElgN98WqsbMMjqa6IkfyNoN3zE3KyJ96RSxrKi0nHw/viewform)

---

## What's new in v0.3.2

- **Works alongside PGA and Voxels** — the extension now coexists cleanly with Pixels Game Addons (PGA) and the Voxels extension. The Phaser hook chains any existing setter rather than overwriting it, and a startup fallback poll ensures the game is detected even if another extension rewires `window.Phaser`. At startup the console logs `[coexist] detected: Voxels` / `detected: PGA` so you can confirm all three extensions are active.
- **Taskboard resilient to PGA DOM rewrites** — six independent detection strategies (CSS wildcards, heading-sibling scan, order-class parent scan, Deliver-button ancestor scan, React-fiber card scan, presentUI fallback) find the taskboard container even when PGA has restructured the DOM. Each strategy logs its result with a `[taskboard] S1…S6` prefix.
- **Setter-overwrite warning** — if another extension replaces our `window.Phaser` setter without chaining it, the console logs `[coexist] window.Phaser setter overwritten — relying on startup poll` so the issue is visible rather than silent.

---

## What's new in v0.3.1

- **Taskboard works again after the Pixels game update** — the reader now pulls order data directly from the game's own data layer rather than scraping visible text, so future style or layout changes in the game won't break it
- **Shows when an order is ready to deliver** — orders you already have items for are marked "✓ ready to deliver" both in the companion panel and in answers
- **Stacked App and Crafting panel made update-proof the same way** — their readers also switched to wildcard class matching so a Stacked or Crafting redeploy no longer silences them
- **Quieter console** — poller errors log once instead of every tick; noisy debug entries removed

See [CHANGELOG.md](CHANGELOG.md) for v0.3.0 and earlier.

---

## What's new in v0.3.0

- **Storage pop-up** — browse your chest/storage contents from inside the companion panel; inventory answers include storage totals
- **Pet detection** — the companion knows whether you have a pet and factors it into answers
- **Buy vs craft decisions** — taskboard orders now show whether buying or crafting the missing items is cheaper, and surface market-volume warnings when stock is thin
- **Smarter inventory answers** — items grouped by location, friendly names throughout
- **Onboarding** — the companion introduces itself once and doesn't repeat the pitch every session

---

## How to install (Chrome, Brave or Edge)

1. Download **pixels-dojo-companion.zip** from the [Releases page](../../releases) and unzip it.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Open [https://play.pixels.xyz](https://play.pixels.xyz) and log in — click the torii arch to meet your companion.

**Updating:** download the new zip, replace the folder, then click the reload icon on the extension card.

It's a work in progress — feedback welcome: [Feedback form](https://docs.google.com/forms/d/e/1FAIpQLScuYiSpElgN98WqsbMMjqa6IkfyNoN3zE3KyJ96RSxrKi0nHw/viewform)

---

## What is it?

The Pixels Dojo Companion is a Chrome extension + backend service that gives you an in-game AI assistant. Ask questions in plain English and get answers grounded in your actual game state — your current skills, energy, inventory, taskboard orders, and more.

The assistant comes in three personas:
- **Pixin** — polite and concise
- **Royagi** — wise dojo master with the occasional farming pun
- **Nyanko** — warm and enthusiastic cat companion

## Features

- **Ask anything** — "where can I mine tier 3 on water land?", "what should I craft to level Stoneshaping?", "do I have items for my taskboard?"
- **Live context** — reads your energy, skills, inventory, taskboard orders, and Stacked App offers so answers are specific to *you right now*
- **Goals tracker** — "add reach Stoneshaping 45 to my goals"; tracks XP progress toward your targets
- **Ready-land finder** — searches public lands with available industries (mine, farm, cook, etc.) and live-checks spot availability
- **Taskboard helper** — shows what you can deliver, what's missing, and which order has best net Coin value
- **Stacked App** — lists your current Pixel-earning offers at a glance
- **Shopping list** — "add 50 wood to my shopping list", computed from crafting recipes
- **Skill XP guide** — ranks recipes by XP/energy for any skill

## Privacy

- The extension reads your game state (skills, inventory, energy) **only to answer your questions**
- It **never automates play** — no clicks, no transactions, no game actions on your behalf
- It **never touches your wallet** — no signing, no approvals, no blockchain interactions
- Player data sent to the backend is used only to generate answers and is not stored beyond what is needed for goal/notebook features
- Market price data is aggregated item-level only (no player identifiers)

## Backend setup (self-hosting)

The extension points to a backend server that handles AI inference. The server requires:

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally (default model: `qwen2.5:3b`)
- SQLite (via `better-sqlite3`, included)

```bash
npm install
cp .env.example .env   # edit as needed
npm run build
npm start
```

Key environment variables (see `.env.example`):

| Variable | Description |
|---|---|
| `OLLAMA_URL` | Ollama API base URL |
| `OLLAMA_MODEL` | Model name (default: `qwen2.5:3b`) |
| `DATABASE_PATH` | SQLite file path |
| `PIXELS_SERVER_URL` | Pixels game server URL |
| `DEBUG_KEY` | Secret key for `/debug/*` endpoints — leave unset to disable all debug routes |

## Community

- Website: [pixelsdojo.xyz](https://www.pixelsdojo.xyz)
- Feedback: [Share your thoughts](https://docs.google.com/forms/d/e/1FAIpQLScuYiSpElgN98WqsbMMjqa6IkfyNoN3zE3KyJ96RSxrKi0nHw/viewform)
