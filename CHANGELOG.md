# Changelog

## v0.3.1 — 7 October 2026

### What's new

**Taskboard works again after the Pixels game update**
The extension now reads taskboard orders directly from the game's internal data layer (React fiber props) rather than scraping rendered text. This means future Pixels style updates, class renames, or layout changes won't break the taskboard reader.

**Shows when an order is ready to deliver**
Each order now reports whether the game itself says you can deliver it right now. Orders you have items for are shown with "✓ ready to deliver" in both the companion panel and in answers like "do I have items for my taskboard?"

**Stacked App and Crafting panel made update-proof the same way**
The Stacked offers list and the Crafting detail panel now use wildcard CSS class matching (`[class*="…"]`) instead of exact hashed selectors. A Stacked or Crafting redeploy used to silently break their readers; this closes that gap.

**Quieter console**
Poller errors (Stacked, Crafting, auth interceptor) now log once per session instead of every 200 ms tick. Several verbose debug entries removed.

---

## v0.3.0 — 4 October 2026

### What's new

**Storage view**
Ask "what's in my storage?" or "do I have enough wood?" and the companion checks all your chests across every land location — with game icons, per-location totals, and a searchable list. No more opening chests one by one.

**Taskboard planner**
The taskboard answer now shows a full breakdown for each order: how much you have (backpack + storage), how much you still need, the cost to fill it (buy from market or craft from your own stock with energy shown), expected profit/loss, and whether it fits within your coin limit. "What task first?" or "top seven tasks" ranks all open orders by net coin value.

**Sabotage stone count**
Ask "how many sabotage stones do I have?" or "stones for Bountyfall" and get the count straight from your inventory.

**Pet + storage detected automatically in setup**
The setup flow now detects whether you have an active pet and whether storage data is available — no manual checkboxes needed.

**Profile, intro, and Today's XP survive updates**
Your name, chosen companion, intro preference, and Today's XP data are now preserved when the extension updates, so you don't have to re-enter your name or lose your XP log.

**Shopping list from recipes**
After any crafting answer, say "add those items" (or "add those to my shopping list") and the ingredients are added to your shopping list automatically.

**Friendlier answers**
Energy cost is shown on every craft option. Craft lines read "craft from your stock · 0 coins · N⚡" when you already own all the ingredients. Clearer phrasing throughout.

---

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
