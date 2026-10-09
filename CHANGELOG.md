# Changelog

## v0.3.2 — 9 October 2026

### What's new

**Works alongside PGA and Voxels**
Pixels Game Addons (PGA) and the Voxels extension can now run at the same time without breaking the companion. The Phaser hook chains any existing setter rather than replacing it, a 30-second startup fallback poll ensures the game is always detected, and a setter-overwrite warning fires in the console if another extension rewires `window.Phaser` without chaining. On load the console logs `[coexist] detected: Voxels / PGA` so you can confirm all extensions are active.

**Taskboard finds your orders in several ways**
Six independent detection strategies (CSS wildcards, heading-sibling scan, order-class parent scan, Deliver-button ancestor, React-fiber card scan, presentUI fallback) find the taskboard even when PGA has restructured the DOM. Each strategy logs `[taskboard] S1…S6` so nothing fails silently.

**Morning plan picks your best orders first**
The daily "what should I do today?" answer now surfaces ready-to-deliver orders and orders you can craft from stock at the top, followed by the best Stacked offers you can fill. Orders you cannot do yet are ranked last.

**Backend improvements (already live for all players)**
- Strategy answer uses the same profit maths as the top-7 taskboard ranking
- "Have I got…" questions check storage as well as backpack
- Honey source and recipe have-counts include storage totals
- New-player guide gives beginners a step-by-step path for the first day

---

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

**Storage pop-up**
A new overlay lets you browse your chest and storage contents from inside the companion panel. Inventory answers now include storage totals alongside backpack counts, grouped by location.

**Pet detection**
The companion reads whether you have a pet active and factors it into relevant answers (energy, feeding).

**Buy vs craft decisions on taskboard orders**
For each taskboard order, the companion calculates whether buying the missing items on the market or crafting them from your stock is cheaper, and shows a "⚡ energy" note for crafting paths. Market-volume warnings appear when there isn't enough listed stock to fill the order.

**Smarter inventory answers**
Items are grouped by location (backpack, house storage, farm chests), use friendly display names throughout, and no longer show spurious chest-not-opened warnings.

**Onboarding — introduce once, not every session**
The companion introduces itself the first time you open it and remembers not to repeat the pitch on future sessions.

**Sabotage yieldstone counts**
"How many yieldstones does the Hearth Hall sabotage give?" and similar questions now pull from static data instead of sending the question to the AI.

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
