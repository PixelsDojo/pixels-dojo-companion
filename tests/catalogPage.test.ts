/**
 * Automated sanity check for the /catalog HTML page.
 *
 * Run: npm test
 *
 * Uses only Node built-ins + ts-node (no extra test framework).
 * Sets DATABASE_PATH=:memory: before loading the database module so no
 * on-disk file is created.
 */
import assert from "assert";
import vm from "vm";
import type { CatalogRow } from "../src/db/database";

// Must come before the require() below so database.ts sees it.
process.env.DATABASE_PATH = ":memory:";

// Dynamic require keeps the env assignment above the DB module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildHtmlPage } = require("../src/routes/catalogPublic") as {
  buildHtmlPage: (rows: CatalogRow[], meta: null, publicView?: boolean) => string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string, name: string, category = "crafted", extra: Partial<CatalogRow> = {}): CatalogRow {
  return {
    item_id: id, display_name: name, category, industry: null, tier: 1,
    skill: "crafting", level_required: 1, tool_type: null, tool_min_tier: null,
    seed_id: null, seed_name: null, grow_time_minutes: null,
    plant_energy: null, harvest_energy: null, harvest_xp: null,
    recipe_station: "Crafting Bench",
    recipe_inputs: JSON.stringify([{ id: "itm_wood", name: "Wood", qty: 2 }]),
    recipe_output_qty: 1, craft_time_minutes: 1, craft_energy: 5, craft_xp: 10,
    is_event_recipe: 0, all_recipes: null, land_type: null, library_ver: "10.5",
    updated_at: Date.now(),
    ...extra,
  };
}

/** Extract and parse DATA=[...] from the HTML page. */
function extractData(html: string): unknown[] {
  const m = html.match(/^var DATA=(.+);$/m);
  assert.ok(m, "DATA variable not found in page HTML — script block may be broken");
  return JSON.parse(m![1]) as unknown[];
}

let passed = 0;

// ---------------------------------------------------------------------------
// Test 1: row count in DATA matches input rows
// ---------------------------------------------------------------------------
{
  const rows = [
    makeRow("itm_a", "Apple"),
    makeRow("itm_b", "Banana"),
    makeRow("itm_c", "Cherry"),
  ];
  const html = buildHtmlPage(rows, null);
  const data = extractData(html);
  assert.strictEqual(data.length, rows.length,
    `DATA.length (${data.length}) !== rows.length (${rows.length})`);
  console.log("✓ row count matches");
  passed++;
}

// ---------------------------------------------------------------------------
// Test 2: </script> injection is escaped — DATA must still be parseable
// ---------------------------------------------------------------------------
{
  const rows = [makeRow("itm_x", '</script><script>alert(1)</script>', "crafted")];
  const html = buildHtmlPage(rows, null);
  // The literal </script> must NOT appear unescaped inside the <script> block
  assert.ok(
    !html.includes("</script><script>alert(1)"),
    "XSS: unescaped </script> found in page output",
  );
  const data = extractData(html);
  assert.strictEqual(data.length, 1, "Should still have 1 item after escaping");
  console.log("✓ </script> injection escaped");
  passed++;
}

// ---------------------------------------------------------------------------
// Test 3: null/missing recipe fields don't throw
// ---------------------------------------------------------------------------
{
  const rows = [
    makeRow("itm_null", "Null Fields", "crafted", {
      recipe_inputs: null,
      all_recipes: null,
      recipe_station: null,
      recipe_output_qty: null,
      craft_time_minutes: null,
      craft_energy: null,
      craft_xp: null,
    }),
  ];
  const html = buildHtmlPage(rows, null);
  const data = extractData(html);
  assert.strictEqual(data.length, 1, "Null-field row should appear in DATA");
  console.log("✓ null recipe fields handled");
  passed++;
}

// ---------------------------------------------------------------------------
// Test 4: apostrophes and other special characters in item names
// ---------------------------------------------------------------------------
{
  const rows = [
    makeRow("itm_tree", "Pixmas Tree ('23)", "retired"),
    makeRow("itm_quote", 'Item with "quotes"', "crafted"),
  ];
  const html = buildHtmlPage(rows, null);
  const data = extractData(html);
  assert.strictEqual(data.length, 2, "Items with apostrophes/quotes should parse correctly");
  const items = data as Array<{ n: string }>;
  assert.ok(items.some((d) => d.n === "Pixmas Tree ('23)"), "Apostrophe item name preserved");
  assert.ok(items.some((d) => d.n === 'Item with "quotes"'), "Quote item name preserved");
  console.log("✓ apostrophes and quotes in names handled");
  passed++;
}

// ---------------------------------------------------------------------------
// Test 5: multi-recipe item (all_recipes JSON) serialized correctly
// ---------------------------------------------------------------------------
{
  const allRecipes = JSON.stringify([
    { achId: "ach_1", station: "Bench", levelRequired: 5, inputs: [{ id: "itm_a", name: "A", qty: 1 }], outputQty: 2, isEvent: 0 },
    { achId: "ach_2", station: null,    levelRequired: null, inputs: [{ id: "itm_b", name: "B", qty: 3 }], outputQty: 1, isEvent: 1 },
  ]);
  const rows = [makeRow("itm_multi", "Multi Recipe Item", "crafted", { all_recipes: allRecipes })];
  const html = buildHtmlPage(rows, null);
  const data = extractData(html);
  assert.strictEqual(data.length, 1);
  const item = (data as Array<{ ars: number; ar: string }>)[0];
  assert.strictEqual(item.ars, 2, "all_recipes count should be 2");
  assert.ok(item.ar !== null, "ar field should be set");
  console.log("✓ multi-recipe item serialized correctly");
  passed++;
}

// ---------------------------------------------------------------------------
// Test 6: inline <script> block is syntactically valid JavaScript
// ---------------------------------------------------------------------------
{
  const rows = [
    makeRow("itm_apos",  "Player's Candle",       "crafted"),
    makeRow("itm_apos2", "Buck's Lucky Coin",      "crafted"),
    makeRow("itm_dquot", 'The "Great" Hat',        "crafted"),
    makeRow("itm_inj",   '</script><script>bad()', "crafted"),
    makeRow("itm_seed",  "Pepper Seed",            "seed",    { seed_name: "Buck's Pepper", category: "seed" }),
    makeRow("itm_land",  "Estate Plot",            "land",    { land_type: "Player's Land" }),
  ];
  // Use publicView=false so all rows (including any null-cat) are included
  const html = buildHtmlPage(rows, null, false);

  // Extract script body between first <script> tag and matching </script>
  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "No <script> block found in page HTML");
  const scriptText = scriptMatch![1];

  // vm.Script will throw SyntaxError if the script is invalid
  let syntaxOk = false;
  try {
    new vm.Script(scriptText);
    syntaxOk = true;
  } catch (e) {
    assert.fail(`Script block failed to parse: ${(e as Error).message}`);
  }
  assert.ok(syntaxOk, "vm.Script should have parsed without error");

  // DATA must still have all rows
  const data = extractData(html);
  assert.strictEqual(data.length, rows.length, "All rows should appear in DATA");

  // The apostrophe-containing names must survive the round-trip
  const items = data as Array<{ n: string }>;
  assert.ok(items.some((d) => d.n === "Player's Candle"),  "Apostrophe preserved: Player's Candle");
  assert.ok(items.some((d) => d.n === "Buck's Lucky Coin"), "Apostrophe preserved: Buck's Lucky Coin");
  assert.ok(items.some((d) => d.n === 'The "Great" Hat'),  "Double-quote preserved: The \"Great\" Hat");

  console.log("✓ script block parses cleanly (apostrophes, quotes, </script> injection)");
  passed++;
}

console.log(`\nAll ${passed} catalog page tests passed.`);
