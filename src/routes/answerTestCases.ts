// Shared regression test cases for /v1/ask.
// Used by both the server-side /api/debug/answer-tests endpoint and
// the CLI script at scripts/answer-tests.ts — edit here, reflected in both.

export interface AnswerTestCase {
  question:  string;
  checks:    Array<string | RegExp>;    // ALL must match (string = substring, RegExp = test)
  notChecks?: Array<string | RegExp>;  // NONE must match
  label:     string;
}

// Skills that sum to 432 (Lizzy's confirmed total).
// "overall: 67" is the profile-level field — NOT the sum.
export const TEST_PLAYER_SKILLS: Record<string, number | { level: number; totalExp: number }> = {
  farming:      50,
  mining:       45,
  forestry:     40,
  fishing:      35,
  stoneshaping: 50,
  petcare:      40,
  cooking:      35,
  woodworking:  30,
  exploration:  32,
  building:     30,
  tailoring:    30,
  metalworking: 15,
  overall:      67,   // profile-level field — excluded from sum by formatLevels
};
// 50+45+40+35+50+40+35+30+32+30+30+15 = 432 ✓

// Test context: fake wallets (no land in DB) + Lizzy-shaped skill set.
// Using a known-missing wallet so playerOwnedLandType = null (not undefined),
// which still triggers yes/no crop logic with an anonymous "you don't own" message.
export const TEST_CONTEXT = {
  player: {
    playerId: "regression-test",
    factionId: 1,   // Wildgroves — needed for sabotage tests
    skills: TEST_PLAYER_SKILLS,
    inventory: { itm_turkeyPowder: 5 },
    // Taskboard entries: Turkey Egg Powder (have 5, need 3 → ready to deliver)
    // and Clover Fruit (have 37 in storage, need 100 → cost unknown, no market price)
    taskboard: [
      { itemName: "Turkey Egg Powder", tier: "", quantityNeeded: 3, itemId: "itm_turkeyPowder",
        costs: ["0", "500"], rewardItems: [], isVipLocked: false, canDeliverNow: true },
      { itemName: "Clover Fruit", tier: "", quantityNeeded: 100, itemId: "itm_cloverFruit",
        costs: ["0", "1000"], rewardItems: [], isVipLocked: false, canDeliverNow: false },
      // Unpriced order — no market entry → fill cost will be unknown
      { itemName: "Quellfunk Sap", tier: "", quantityNeeded: 10, itemId: "itm_quellfunkSap_fake",
        costs: ["0", "800"], rewardItems: [], isVipLocked: false, canDeliverNow: false },
    ],
    storageChests: {
      "chest_test_9bb2": {
        items: [{ itemId: "itm_cloverFruit", qty: 37 }],
        size: 30,
        storageName: "Chest 1",
        landId: "shareRent1234567",   // real format: no dash → "Speck outside"
        capturedAt: 1700000000000,
        source: "selfPlayer",
      },
      "chest_test_speck_milk": {
        items: [{ itemId: "itm_pig_pigMilk", qty: 2 }],
        size: 30,
        storageName: "Chest 2",
        landId: "shareRent1234567",
        capturedAt: 1700000000000,
        source: "selfPlayer",
      },
      "chest_test_nft_milk": {
        items: [{ itemId: "itm_pig_pigMilk", qty: 2 }],
        size: 30,
        storageName: "Chest 3",
        landId: "pixelsNFTFarm-486",  // → "Land 486 outside"
        capturedAt: 1700000000000,
        source: "selfPlayer",
      },
    },
  },
  walletAddress: "0x0000000000000000000000000000000000testxx",
};

export const ANSWER_TEST_CASES: AnswerTestCase[] = [
  {
    question: "can i plant muckchuck",
    checks:   [/^Yes/i],
    label:    "muckchuck — any-land crop leads with Yes",
  },
  {
    question: "can i plant watermint",
    checks:   [/^No/i, /water/i],
    label:    "watermint — water-only crop leads with No + water lands",
  },
  {
    question: "can i plant magnoot",
    checks:   [/^Yes/i],
    label:    "magnoot — grass crop leads with Yes",
  },
  {
    question: "can i plant astracactus",
    checks:   [/^No/i, /space/i],
    label:    "astracactus — space crop leads with No + space lands",
  },
  {
    question: "where do i mine salt",
    checks:   [/water/i],
    label:    "salt — water-only mine mentions water land",
  },
  {
    question: "where do i mine magnetite ore",
    checks:   [/grass/i],
    label:    "magnetite ore — grass mine mentions grass land",
  },
  {
    question: "where can i do tier 3 stoneshaping",
    checks:   [/\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "tier 3 stoneshaping — lists lands",
  },
  {
    question: "where can i farm tier 4",
    checks:   [/\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "tier 4 farming — lists lands",
  },
  {
    question: "where can i buy UGCs",
    checks:   [/don['']t know|don't know|not.*find|no.*item/i],
    notChecks: [/sell.*farmed|farmed.*item/i],
    label:    "UGCs — unknown item, no LLM invention",
  },
  {
    question: "where do i get silk",
    checks:   [/silk fiber|silk cloth/i],
    label:    "silk — mentions Silk Fiber or Silk Cloth first",
  },
  {
    question: "where do i get silk fiber",
    checks:   [/silk slug|sluggery/i],
    label:    "silk fiber — mentions Silk Slug or Sluggery",
  },
  {
    question: "where can i make bedrock bricks",
    checks:   [/bedrock powder|stoneshaping/i, /\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "bedrock bricks — shows recipe + stoneshaping lands",
  },
  {
    question: "how can i earn coins",
    checks:   [/coin|earn/i],
    label:    "earn coins — mentions ways to earn coins",
  },
  {
    question: "what is my overall level",
    checks:   ["432"],
    notChecks: [/\b67\b/],
    label:    "overall level — returns skill sum 432, not profile field 67",
  },
  {
    question: "where can i bbq",
    checks:   [/\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "bbq — lists lands with BBQ entity",
  },
  {
    question: "where can i chop tier 4 trees",
    checks:   [/\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "tier 4 tree chopping — lists lands",
  },
  // ---- Issue B: Genesis Runners retired ----
  {
    question: "where can i get genesis runners",
    checks:   [/can't be crafted|not.*craftable|retired|marketplace/i],
    notChecks: [/silk cloth|textile mill/i],
    label:    "Genesis Runners — retired, not craftable at textile mill",
  },
  // ---- Issue C: animal products name the animal ----
  {
    question: "how do i get cow milk",
    checks:   [/cows?/i],
    notChecks: [/an animal on your land/i],
    label:    "cow milk — names Cows not generic animal",
  },
  {
    question: "how do i get wool wad",
    checks:   [/sheep/i],
    notChecks: [/an animal on your land/i],
    label:    "wool wad — names Sheep not generic animal",
  },
  // ---- Issue D: grass land type resolves correctly ----
  {
    question: "where do i mine magnetite ore",
    checks:   [/grass|land \d+/i],
    notChecks: [/no public lands.*found/i],
    label:    "magnetite ore — grass land type resolves, finds lands",
  },
  {
    question: "where can i mine on grass land",
    checks:   [/\bLand \d+\b/i],
    notChecks: [/no public lands/i],
    label:    "grass land mining — lists lands with mine",
  },
  // ---- Issue E: forge routes to land finder ----
  {
    question: "where can i use a forge",
    checks:   [/\bLand \d+\b|metalwork/i],
    notChecks: [/alchemic forge.*craft|how to craft.*forge/i],
    label:    "where can i use a forge — finds metalwork lands, not craft guide",
  },
  // ---- Issue F: raw products rank before decor/dishes ----
  {
    question: "how do i get milk",
    checks:   [/cow milk|goat milk|pig milk/i],
    notChecks: [/miniature milk barrel|grilled bread/i],
    label:    "milk disambiguation — cow/goat/pig milk ranked before decor/dishes",
  },
  // ---- Skill alias + display name ----
  {
    question: "whats the best woodwork recipe for me",
    checks:   [/woodwork(?:ing)?/i, /xp.*energy|energy.*xp|XP\/energy/i],
    label:    "woodwork recipe — skill alias resolves and returns XP-per-energy list",
  },
  // ---- Reverse recipe fast path ----
  {
    question: "what can i make with turkey egg powder",
    checks:   [/turkey egg powder/i, /feather fluff|straining mesh/i],
    label:    "reverse recipe — turkey egg powder ingredient lookup",
  },
  // ---- Strategy grounding — stoneshaping is NOT the weakest skill ----
  {
    question: "whats a good strategy for me",
    checks:   [/.{10}/],
    notChecks: [/stoneshaping.*(?:weakest|lowest)|(?:weakest|lowest).*stoneshaping/i],
    label:    "strategy — does not claim stoneshaping is the weakest skill",
  },
  // ---- Inventory + storage fast path ----
  {
    question: "how many clover do i have",
    checks:   [/37/i, /clover/i, /speck outside/i],
    notChecks: [/don't have any|no clover/i],
    label:    "clover count — finds 37 in Speck outside, shows location",
  },
  {
    question: "do i have turkey egg powder",
    checks:   [/yes|you have/i, /turkey/i],
    notChecks: [/don't have|no turkey/i],
    label:    "turkey egg powder — finds 5 in backpack",
  },
  // ---- Clover zero-path confirms resolution (item in storage, not backpack) ----
  // The 37-clover chest (shareRent1234567) tests the non-zero storage path above.
  // This entry just re-confirms resolution never confuses Clover with a seed.
  {
    question: "how many clover do i have",
    checks:   [/37/i, /clover/i, /speck outside/i],
    notChecks: [/clover.*seed|seed.*clover/i],
    label:    "clover — resolves to Clover (itm_cloverFruit), not a seed; shows 37 in Speck outside",
  },
  // ---- Gravelglass: inventory query must never reach LLM ----
  {
    question: "how many gravelglass do i have",
    checks:   [/gravelglass|no.*backpack/i],
    notChecks: [/do not have access|I cannot access|I don.t have access/i],
    label:    "gravelglass — inventory fast path answers (no LLM fallthrough)",
  },
  // ---- Pig Milk: breakdown across two locations ----
  {
    question: "how many pig milk do i have",
    checks:   [/pig milk/i, /4/i, /speck outside/i, /land 486/i],
    notChecks: [/don.t have|no pig milk/i],
    label:    "pig milk — 4 total, 2 in Speck outside · 2 in Land 486 outside",
  },
  // ---- Strategy route: must reach strategy handler, not fallback ----
  {
    question: "whats a good strategy for me",
    checks:   [/.{20}/],
    notChecks: [/not sure about that|I am not sure about that one yet/i],
    label:    "strategy phrase — reaches strategy route, not fallback",
  },
  {
    question: "what should i do today",
    checks:   [/.{20}/],
    notChecks: [/not sure about that|I am not sure about that one yet|not familiar with an item/i],
    label:    "do today — reaches strategy route, not item catalog",
  },
  {
    question: "where do i start",
    checks:   [/.{20}/],
    notChecks: [/not sure about that|I am not sure about that one yet/i],
    label:    "where do i start — reaches strategy route, not fallback",
  },
  // ---- Live test fixes ----
  {
    question: "what task should i complete first",
    checks:   [/have \d+\/\d+|ready to deliver|costs? ~|pays \d/i],
    notChecks: [/I do not see|can't see your taskboard|I can't see|do not have access/i],
    label:    "taskboard first — top-1 ranked order with have/cost/pay (needs live taskboard or cache)",
  },
  {
    question: "top seven tasks",
    checks:   [/have \d+\/\d+|ready to deliver|1\./i],
    notChecks: [/do not have access|I don.t have access|can.t see your taskboard/i],
    label:    "top seven tasks — matches TASKBOARD_TOP route (not LLM fallback)",
  },
  {
    question: "how much does clayum powder cost",
    checks:   [/market|coins/i, /craft|recipe|ingredient|not craftable/i],
    notChecks: [/costs no coins to make|free to craft/i],
    label:    "clayum powder cost — shows market price AND craft cost (or not craftable)",
  },
  {
    question: "how do i make wiggly fluppy nigiri",
    checks:   [/sushi station|seaweed|fluppy|nigiri/i],
    notChecks: [/recipe scroll|recipe item/i],
    label:    "fluppy nigiri — answers for dish not recipe scroll",
  },
  {
    question: "how do i make fluppy nigiri",
    checks:   [/nigiri|sushi/i],
    notChecks: [/Wiggly Fluppy Nigiri.*Wiggly Fluppy Nigiri/i],
    label:    "fluppy nigiri — recipe not listed twice",
  },
  {
    question: "whats a good strategy for me",
    checks:   [/stacked|taskboard|order|offer/i, /.{20}/],
    notChecks: [/maintain.*routine|keep.*doing|Please note|You possess/i],
    label:    "strategy — leads with Stacked or Taskboard, no filler, no banned phrases",
  },
  // ---- Issue 8: Sabotage count ----
  {
    question: "how many sabotages do i have",
    checks:   [/sabotage|yieldstone|verdant|flint|hollow/i],
    notChecks: [/I do not know|can.t see|no data/i],
    label:    "sabotage count — answers with yieldstone info (no faction in test context → no-data path)",
  },
  // ---- Live test fixes (4 Oct) ----
  // Issue 1: taskboard have count uses real inventory (not always 0)
  {
    question: "what task should i complete first",
    checks:   [/turkey egg powder/i, /ready to deliver|have [1-9]/i],
    notChecks: [/have 0\/3/i, /can.t see your taskboard/i],
    label:    "taskboard first — have count uses real inventory, not 0 (fix issue 1)",
  },
  // Issue 2: no '💰 worth doing' when fill cost is unknown (Quellfunk Sap has no market price)
  {
    question: "top seven tasks",
    checks:   [/quellfunk sap/i, /cost unknown/i],
    notChecks: [/quellfunk.*💰 worth doing|💰 worth doing.*quellfunk/i],
    label:    "taskboard top — no '💰 worth doing' when cost unknown (fix issue 2)",
  },
  // Issue 3: identical-input recipes merged into one line with combined station name
  {
    question: "how do i make wiggly fluppy nigiri",
    checks:   [/sushi station.*or.*public sushi|public sushi.*or.*sushi station/i],
    notChecks: [/Recipe 1:.*Recipe 2:|different recipes/i],
    label:    "fluppy nigiri — identical-input recipes merged, stations combined (fix issue 3)",
  },
  // Issue 6: follow-up 'those items' resolves last recipe's ingredients
  // Note: depends on the fluppy nigiri recipe test running first (sets lastItemContextMap)
  {
    question: "please add those items to my shopping list",
    checks:   [/added.*shopping list|seaweed|fluffgrice/i],
    notChecks: [/not sure which items|couldn't find 'those items'/i],
    label:    "shopping follow-up — 'those items' resolves last recipe ingredients (fix issue 6)",
  },
  // Issue 7: sabotage answer is plain text with no markdown bold markers
  {
    question: "how many sabotages do i have",
    checks:   [/wildgroves|flint|hollow/i],
    notChecks: [/\*\*/],
    label:    "sabotage count — plain text, no markdown bold (fix issue 7)",
  },
  // ---- Live test fixes (5 Oct) ----
  // Issue 1: taskboard have count resolved from item NAME (not cached itemId)
  {
    question: "what task should i complete first",
    checks:   [/turkey egg powder/i, /ready to deliver/i],
    notChecks: [/have 0\/3/i, /can.t see your taskboard/i],
    label:    "taskboard first — turkey ready to deliver (have 5 ≥ 3), resolved from item name (fix issue 1 redux)",
  },
  {
    question: "top seven tasks",
    checks:   [/turkey egg powder/i, /ready to deliver/i],
    notChecks: [/have 0\/3|have 0,/i, /can.t see your taskboard/i],
    label:    "taskboard top — turkey ready to deliver resolved from name, not 0 (fix issue 1 redux)",
  },
  // Issue 2: fill cost uses DB market price (not player-captured prices which are empty)
  // Turkey (have 5/3) → ready to deliver, no fill cost needed
  // Clover (have 37/100) → stillNeed=63, show "costs ~X" if priced else "cost unknown" (not a regression)
  {
    question: "what task should i complete first",
    checks:   [/turkey egg powder/i, /ready to deliver/i],
    notChecks: [/cost unknown.*turkey|turkey.*cost unknown/i],
    label:    "taskboard first — no spurious 'cost unknown' for ready orders (fix issue 2 redux)",
  },
  // Issue 3: recipe fast path skips LLM rephrase — compact format, no prose
  {
    question: "how do i make wiggly fluppy nigiri",
    checks:   [/Needs:/i, /Sushi Station/i],
    notChecks: [/Please prepare|Utilize|The process demands|kindly|In order to/i],
    label:    "fluppy nigiri — recipe format uses 'Needs:' not LLM prose (fix issue 3)",
  },
  {
    question: "how do i make wiggly fluppy nigiri",
    checks:   [/have \d+\s*✓|have 0\b/i],
    notChecks: [/you have \d+\)/i],
    label:    "fluppy nigiri — ingredient have-count uses new ✓ format (fix issue 3)",
  },
];
