# Pixels Dojo Companion

**v0.2.0** — An AI companion for [Pixels Online](https://pixels.xyz) — instant answers, strategy advice, and live context-aware help, right inside the game.

> **Work in progress — feedback very welcome!**
> Share thoughts, bugs, or suggestions: [Feedback form](https://docs.google.com/forms/d/e/1FAIpQLScuYiSpElgN98WqsbMMjqa6IkfyNoN3zE3KyJ96RSxrKi0nHw/viewform)

---

## What's new in v0.2.0

- **Activity timers** — crop and crafting countdowns named by item (Stove · Vinegar, Woodwork · Axe, etc.), persistent across map changes
- **Today's XP** in the Diary: per-skill gains since midnight, level-up markers, Yesterday view
- **Stop button** — cancel Pixin's answer mid-request (or press Esc)
- **Goals** fill in skill levels automatically ("reach Stoneshaping \<level>" → "reach Stoneshaping 45")
- Works alongside other Pixels extensions; lighter on the game's loading

See [CHANGELOG.md](CHANGELOG.md) for full details.

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

- Website: [pixelsdojo.xyz](https://pixelsdojo.xyz)
- Feedback: [Share your thoughts](https://docs.google.com/forms/d/e/1FAIpQLScuYiSpElgN98WqsbMMjqa6IkfyNoN3zE3KyJ96RSxrKi0nHw/viewform)
