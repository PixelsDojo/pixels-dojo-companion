# Changelog

## v0.2.0 — 2 October 2026

### What's new

**Activity timers**
Crops (Tato, Popberry, etc.), Stove dishes, Woodwork, Metalworking, Kiln, Winery, and other crafting stations now show live countdown timers. Timers are named by crop or item ("Stove · Vinegar", "Woodwork · Axe"), grouped together, and stay on screen when you move between your farm and your house.

**Manual timers moved to the Timers tab**
Manual timers you set yourself live in the Timers tab alongside the activity timers, keeping the Diary tab clean.

**Today's XP in the Diary tab**
Open the Diary and the first thing you see is a "Today's XP" card: your skill XP gains since the start of your local day, sorted from biggest to smallest, with a level-up marker ("Lv 44 → 45 🎉") when you ding. A total row shows how much XP you earned in one session. Tap "Yesterday" to see the previous day.

**Stop button for companion answers**
While Pixin (or Royagi, or Nyanko) is thinking, the Send button turns into a Stop button ■. Click it — or press Esc — to cancel the request and get your question back in the input box.

**Goals fill in skill levels automatically**
If you type a goal like "reach Stoneshaping \<level>", the companion replaces `<level>` with your current level plus one (e.g. "reach Stoneshaping 45") so your goals always show a concrete target.

**Works alongside other Pixels extensions**
Fixed a conflict that could cause issues when other extensions also modify the fetch API or game state.

**Lighter on the game**
Fixed periodic price-check requests that could slow down the game's own asset loading on slower connections.

---

## v0.1.0 — initial release

First public release. Pixin companion with live context, Goals tracker, Taskboard helper, Stacked App viewer, Shopping list, and Skill XP guide.
