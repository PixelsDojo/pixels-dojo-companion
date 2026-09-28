/**
 * Seed script — populates the wiki_entries table with initial game knowledge.
 * Safe to re-run: INSERT OR REPLACE overwrites on topic conflict rather than
 * duplicating rows.
 *
 * Usage:
 *   npm run seed
 */

import { db, WikiEntry } from "./database";

// Topics that have been split, merged, or corrected and must be removed before
// re-seeding so stale rows don't survive alongside their replacements.
const toDelete: string[] = [
  "hearthall_guild_orders", // split into guild_sell_orders + hearthall_overview + hearthall_bonus_mechanics
];

const entries: Omit<WikiEntry, "id">[] = [
  {
    topic: "energy_regen",
    content:
      "Energy regenerates passively at 0.33333 per minute (about 20 per hour) while offline or idle. There's also a faster active regen rate that only applies while actively playing. Energy above your normal max can be held as surplus energy up to a separate cap, rather than being wasted.",
  },
  {
    topic: "marketplace_fees",
    content:
      "Every marketplace sale has a transaction fee, base rate 1%. VIP members get a reduced rate. Landowners get a further reduced rate after holding land continuously for at least 48 hours. Reputation/trust score can reduce the rate further. These reductions can stack.",
  },
  {
    topic: "gacha_supply_limits",
    content:
      "Gacha systems including the Neon Zone Wheel of Fortune support prizes with limited supply — some rewards can genuinely run out. When a limited prize is exhausted, there's a defined replacement reward fallback rather than the system breaking.",
  },
  {
    topic: "crafting_no_rng",
    content:
      "Crafting is fully deterministic — there is no random chance of failure. You always receive exactly the defined result items and XP; the only thing that can block a craft is insufficient inventory space.",
  },
  {
    topic: "guild_sell_orders",
    content:
      "Guild-shared orders that reset every 24 hours, with up to 9 orders active for a guild at once. There are two separate rewards: a smaller 'contribution reward' given immediately for contributing items, even if the order isn't finished, and a larger 'completion reward' given once the whole order is fulfilled — so partial contribution isn't wasted. Claiming a slot to work on locks it for 5 minutes. Guild 'treasury tax' is explicitly not implemented in the current code.",
  },
  {
    topic: "hearthall_overview",
    content:
      "Each Hearth is tied to a specific faction and a physical location in the world, with its own health bar. Two separate, opposite-direction systems run on it: Deposits raise the Hearth's allied bonus multiplier for your faction. Sabotage lowers a rival Hearth's bonus multiplier instead — but it's capped, it can never be reduced to zero. Both are logged as actions using tiered items.",
  },
  {
    topic: "hearthall_bonus_mechanics",
    content:
      "Every ~5 deposits pushes the allied bonus up one level, each level adding roughly 1% to the multiplier. Every ~8 sabotage actions against a rival Hearth drops its bonus by roughly 10% per level, floored at 40% — sabotage can reduce a rival's bonus by at most 60%, never wipe it out completely. There's a separate personal contribution track alongside the faction-wide one — your own deposits build your own individual bonus level too (roughly every 2 personal deposits per level, +1% each). A separate buffer system layers temporary boosts on top of the base multipliers, tied to specific buff IDs (event-based or purchasable, not yet confirmed which).",
  },
  {
    topic: "energy_drinks",
    content:
      "Energy drinks restore 100 energy for 5,000 gold coins — a straightforward gold-for-energy trade.",
  },
  {
    topic: "taskboard",
    content:
      "Taskboard pays out in gold coins, almost always less than market value. It's meant to progress Stacked App tasks, not for gold profit.",
  },
  {
    topic: "market_liquidity",
    content:
      "Check the market's actual sell history before committing to a high-tier craft — a high listed price doesn't always mean there are real buyers.",
  },
  {
    topic: "land_locked_resources",
    content:
      "Some resources can only be obtained on a specific land type, while others are universal across all land types. Land-locked examples: watermint and voidtonium are planted as crops using seeds bought from the in-game store, but require water-type land to plant at all — they cannot be grown on space or land-type terrain. Salt is a mining resource that can only be found on water-type land. Universal examples, obtainable regardless of land type, include Ochrux Matrix and Copperite Ore. Always check land-type requirements before attempting to plant or mine a specific resource. Most players only own land of one type. To access resources locked to a different land type, visit another player's NFT farm of that type rather than expecting to own multiple types yourself.",
  },
  {
    topic: "guilds_vs_factions",
    content:
      "Guilds and Factions are two separate, unrelated systems. Guilds are joined by buying guild shards, and occasionally the developers run guild-specific quests or events — guild orders (see guild_sell_orders) are a guild-only mechanic, not universal, and many guilds are inactive with no current orders. Factions are entirely different, tied to Hearthall mechanics — deposits and sabotage affecting faction bonus multipliers (see hearthall_overview, hearthall_bonus_mechanics). Never conflate the two: a guild-inactive player should not be advised to use guild orders.",
  },
  {
    topic: "how_pixels_are_earned",
    content:
      "Pixels (and vPixels) cannot be farmed, grown, crafted, or produced directly by leveling any skill — this is a common misconception to avoid. They come from exactly three sources: Stacked App rewards (the reward amount scales up with the player's overall level, which is why leveling up is indirectly valuable), participating in HearthHall (deposits/sabotage), and the Neon Zone weekly leaderboard. All three deposit into the player's in-game wallet. Merchant Boat Contracts (via the HarborMaster south of Terravilla) do NOT pay Pixels — they pay 200–375 Buoy Bucks, 3,000 Business XP, and 15,000–20,000 Coins per order. They are still worth doing for Seaside Stash items (fishing ponds, Sushi Table recipes, Old Salt Strongbox with XP potions). Skills, crafting, farming, mining, and marketplace sales generate XP and coins, never Pixels directly. Coins are a separate currency, earned by selling farmed/mined/crafted items on the marketplace (no XP) or via Taskboard (XP, rarely good coin value) — coins can be spent to buy Pixels, but selling items never earns Pixels directly.",
  },
  {
    topic: "currency_rules",
    content:
      "Currency flow is one-way and non-fungible. Pixels can be spent to buy Coins, but Coins CANNOT be converted back into Pixels — this is a permanent one-way door with no workaround. Buoy Bucks are only spendable in the Seaside Shop; they cannot be sold, exchanged for Coins, or converted to Pixels in any way. Pixels are earned ONLY from Stacked App rewards, HearthHall, and Neon Zone leaderboard. Merchant Boat Contracts do NOT pay Pixels — they pay Buoy Bucks, Coins, and Business XP. HearthHall is high-variance and event-dependent, not a steady or reliable income source; best played by batching contributions. Skills, crafting, farming, and marketplace sales earn XP and Coins only, never Pixels.",
  },
];

// Remove stale topics before upserting so old rows don't survive alongside
// their corrected replacements.
const deleteStmt = db.prepare<string>(
  "DELETE FROM wiki_entries WHERE topic = ?"
);
for (const topic of toDelete) {
  const result = deleteStmt.run(topic);
  if (result.changes > 0) console.log(`  ✗ removed stale: ${topic}`);
}

const insert = db.prepare<Omit<WikiEntry, "id">>(
  "INSERT OR REPLACE INTO wiki_entries (topic, content) VALUES (@topic, @content)"
);

const seedAll = db.transaction((rows: Omit<WikiEntry, "id">[]) => {
  for (const row of rows) {
    insert.run(row);
    console.log(`  ✓ seeded: ${row.topic}`);
  }
});

console.log("Seeding wiki_entries…");
seedAll(entries);
console.log("Done.");

db.close();
