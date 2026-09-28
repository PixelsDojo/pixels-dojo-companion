import { Router, Request, Response } from "express";
import { listCatalogRows, countCatalogRows, getCatalogMeta, getAllMarketPrices } from "../db/database";
import { rebuildCatalogIfNeeded } from "../services/gameCatalog";
import type { CatalogRow, MarketPriceRow } from "../db/database";

const router = Router();

// ---------------------------------------------------------------------------
// Shared: ensure catalog is populated before serving
// ---------------------------------------------------------------------------

async function ensureCatalog(): Promise<void> {
  if (countCatalogRows() === 0) {
    await rebuildCatalogIfNeeded();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRecipeInputs(recipeInputsJson: string | null): string {
  if (!recipeInputsJson) return "";
  try {
    const inputs: Array<{ id: string; name: string; qty: number }> = JSON.parse(recipeInputsJson);
    return inputs.map((i) => `${i.qty}x ${i.name}`).join("; ");
  } catch {
    return "";
  }
}

function formatAllRecipes(allRecipesJson: string | null, displayName: string, outputQty: number | null): string {
  if (!allRecipesJson) return "";
  try {
    const recipes: Array<{
      achId: string;
      station: string | null;
      levelRequired: number | null;
      inputs: Array<{ id: string; name: string; qty: number }>;
      outputQty: number;
      isEvent: number;
    }> = JSON.parse(allRecipesJson);
    return recipes.map((r, i) => {
      const ingStr = r.inputs.map((x) => `${x.qty}x ${x.name}`).join("+");
      return `[${i + 1}] ${ingStr} → ${r.outputQty}x${r.station ? ` @${r.station}` : ""}${r.levelRequired ? ` lv${r.levelRequired}` : ""}${r.isEvent ? " [event]" : ""}`;
    }).join(" | ");
  } catch {
    return "";
  }
}

function rowToFlat(row: CatalogRow) {
  const primaryRecipe = formatRecipeInputs(row.recipe_inputs);
  const allRecipes = formatAllRecipes(row.all_recipes, row.display_name, row.recipe_output_qty);
  return {
    item_id:          row.item_id,
    display_name:     row.display_name,
    category:         row.category ?? "",
    industry:         row.industry ?? "",
    tier:             row.tier ?? "",
    skill:            row.skill ?? "",
    level_required:   row.level_required ?? "",
    // Crop fields
    seed_name:        row.seed_name ?? "",
    grow_time_min:    row.grow_time_minutes ?? "",
    plant_energy:     row.plant_energy ?? "",
    harvest_energy:   row.harvest_energy ?? "",
    harvest_xp:       row.harvest_xp ?? "",
    // Crafting fields
    recipe_station:   row.recipe_station ?? "",
    recipe_inputs:    primaryRecipe,
    recipe_output_qty: row.recipe_output_qty ?? "",
    craft_time_min:   row.craft_time_minutes ?? "",
    craft_energy:     row.craft_energy ?? "",
    craft_xp:         row.craft_xp ?? "",
    is_event_recipe:  row.is_event_recipe ? "yes" : "",
    all_recipes_count: row.all_recipes ? (JSON.parse(row.all_recipes) as unknown[]).length : "",
    all_recipes:      allRecipes,
    land_type:        row.land_type ?? "",
    library_ver:      row.library_ver ?? "",
    updated_at:       new Date(row.updated_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /catalog.json  — excludes unclassified (null-category) items
// ---------------------------------------------------------------------------

router.get("/catalog.json", async (_req: Request, res: Response) => {
  try {
    await ensureCatalog();
    const meta = getCatalogMeta();
    const rows = listCatalogRows().filter((r) => r.category !== null);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      meta: {
        library_ver: meta?.library_ver ?? null,
        item_count:  meta?.item_count  ?? rows.length,
        generated_at: new Date().toISOString(),
        source: "Pixels Online game library",
      },
      items: rows.map(rowToFlat),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /catalog.csv  — excludes unclassified (null-category) items
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  "item_id", "display_name", "category", "industry", "tier", "skill", "level_required",
  "seed_name", "grow_time_min", "plant_energy", "harvest_energy", "harvest_xp",
  "recipe_station", "recipe_inputs", "recipe_output_qty", "craft_time_min",
  "craft_energy", "craft_xp", "is_event_recipe", "all_recipes_count", "all_recipes",
  "land_type", "library_ver", "updated_at",
];

function csvEscape(val: unknown): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

router.get("/catalog.csv", async (_req: Request, res: Response) => {
  try {
    await ensureCatalog();
    const rows = listCatalogRows().filter((r) => r.category !== null);
    const lines: string[] = [CSV_HEADERS.join(",")];
    for (const row of rows) {
      const flat = rowToFlat(row);
      lines.push(CSV_HEADERS.map((h) => csvEscape(flat[h as keyof typeof flat])).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"pixels-catalog.csv\"");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(lines.join("\n"));
  } catch (err) {
    res.status(500).send(String(err));
  }
});

// ---------------------------------------------------------------------------
// GET /catalog  —  mobile-friendly HTML catalog page
// ---------------------------------------------------------------------------

/**
 * Serialize data for safe inline-script embedding.
 * Escapes < so "</script>" sequences can never break out of the script block,
 * and escapes U+2028/U+2029 which are valid in JSON but break JS string literals
 * in some HTML contexts.
 */
function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(" ", "g"), "\\u2028")
    .replace(new RegExp(" ", "g"), "\\u2029");
}

/**
 * Build the catalog HTML page.
 *
 * @param rows       Catalog rows to display (caller may pre-filter).
 * @param meta       Catalog metadata (version, count).
 * @param publicView When true (default), hides items with null category.
 *                   Pass false for the debug view that shows everything.
 *
 * SAFETY RULE: no text value (item name, label, land type, source string)
 * may ever be interpolated directly into a JS string literal inside the
 * <script> block.  All dynamic data goes through safeJsonForScript() so it
 * lives in DATA or LABELS — only CSS class names, HTML tags and DOM selector
 * strings appear as literal JS strings in the static code.
 */
export function buildHtmlPage(
  rows: CatalogRow[],
  meta: { library_ver?: string | null; item_count?: number | null } | null | undefined,
  publicView = true,
  marketPrices?: Map<string, MarketPriceRow>,
): string {
  // Hide unclassified items from the public page/CSV/JSON.
  const displayRows = publicView ? rows.filter((r) => r.category !== null) : rows;

  const updatedAt = new Date().toISOString().slice(0, 10);
  const libVer = meta?.library_ver ?? "?";
  const totalCount = displayRows.length;

  // Collect unique values for filter dropdowns
  const categories = [...new Set(displayRows.map((r) => r.category ?? "").filter(Boolean))].sort();
  const industries = [...new Set(displayRows.map((r) => r.industry ?? "").filter(Boolean))].sort();
  const tiers      = [...new Set(displayRows.map((r) => r.tier).filter((t): t is number => t !== null))].sort((a, b) => a - b);

  // Serialize catalog to minimal JS objects for client-side filtering/sort.
  // ALL fields that contain item text go through safeJsonForScript — never
  // interpolated directly into static JS string literals.
  const jsData = displayRows.map((r) => ({
    id:   r.item_id,
    n:    r.display_name,
    cat:  r.category ?? "",
    ind:  r.industry ?? "",
    t:    r.tier ?? 0,
    sk:   r.skill ?? "",
    lv:   r.level_required ?? 0,
    // Primary recipe (text for summary cell)
    rec:  formatRecipeInputs(r.recipe_inputs),
    // Total recipe count: 0=no recipe, 1=single, 2+=multi
    ars:  (() => { try { return r.all_recipes ? (JSON.parse(r.all_recipes) as unknown[]).length : (r.recipe_inputs ? 1 : 0); } catch { return r.recipe_inputs ? 1 : 0; } })(),
    ev:   r.is_event_recipe ? 1 : 0,
    seed: r.seed_name ?? "",
    grow: r.grow_time_minutes ?? 0,
    sta:  r.recipe_station ?? "",
    sid:  r.seed_id ?? "",
    oqty: r.recipe_output_qty ?? 0,
    // Primary recipe stats
    tm:   r.craft_time_minutes ?? 0,
    en:   r.craft_energy ?? 0,
    xp:   r.craft_xp ?? 0,
    // Gathered / tool info
    tt:   r.tool_type ?? "",
    tmt:  r.tool_min_tier ?? 0,
    // Crop fields
    pe:   r.plant_energy ?? 0,
    he:   r.harvest_energy ?? 0,
    hxp:  r.harvest_xp ?? 0,
    // Full all_recipes JSON (raw string, parsed in JS on demand)
    ar:   r.all_recipes ?? null,
    // Land type restriction (WATER / GRASS / SPACE)
    lt:   r.land_type ?? "",
    // Market demand: sold per day from purchasedQty data (null = no data yet)
    s7d:  marketPrices?.get(r.item_id ?? "")?.sold_7d_est ?? null,
  }));

  // Static label strings that may contain apostrophes or other special chars.
  // Stored here so they are NEVER embedded raw in a JS string literal.
  const labelConfig = {
    buckShop: "Buck's shop",
  };

  // HTML-escape for option/attribute values — prevents XSS in dropdown values.
  const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pixels Catalog</title>
<style>
:root{
  --bg:#0f1117;--surface:#1a1d27;--border:#2d3148;--accent:#7c5cfc;
  --text:#e8e9f0;--muted:#8b8fa8;--detail:#13161f;
  --tag-crop:#2d5a27;--tag-mined:#5a3d1a;--tag-chopped:#2d5a44;
  --tag-crafted:#1a3a5a;--tag-fishing:#1a4a5a;--tag-gathered:#3d4d1a;
  --tag-retired:#5a1a2a;--tag-other:#2d2d3a;
  --tag-animal:#2d3d1a;--tag-seed:#1a3d2d;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.5}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px}
header h1{font-size:28px;font-weight:700;color:#fff}
header .meta{font-size:14px;color:var(--muted);margin-top:4px}
.controls{padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.controls input,.controls select{background:#0f1117;border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:16px;min-width:0}
.controls input{flex:2 1 200px}
.controls select{flex:1 1 140px}
.count-bar{padding:8px 16px;font-size:14px;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border)}
.error-bar{display:none;padding:8px 16px;font-size:14px;font-family:monospace;background:#5a1a1a;color:#ff8080;border-bottom:1px solid #7a3030}
.table-wrap{overflow-x:auto;padding:0 0 80px}
table{width:100%;border-collapse:collapse;min-width:860px}
th{background:var(--surface);position:sticky;top:0;z-index:1;padding:10px 12px;text-align:left;font-size:13px;color:var(--muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--text)}
th.sorted-asc::after{content:" ▲"}
th.sorted-desc::after{content:" ▼"}
.mr td{padding:13px 12px;border-bottom:1px solid var(--border);font-size:16px;vertical-align:middle;cursor:pointer}
.mr:hover td,.mr.open td{background:#1e2130}
.dr td{padding:0;border-bottom:2px solid var(--accent)}
.dp{background:var(--detail);padding:16px 20px;font-size:15px;line-height:1.7}
.dp-id{font-family:monospace;font-size:13px;color:var(--muted);margin-bottom:10px}
.rb{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:10px}
.rb:last-child{margin-bottom:0}
.rl{font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.il{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.ing{background:#1a1d27;border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:15px}
.sr{display:flex;flex-wrap:wrap;gap:4px 20px;margin-top:8px;font-size:14px;color:var(--muted)}
.sr b{color:var(--text)}
.ev{font-size:12px;color:#e0a060;background:#3a2a10;padding:2px 7px;border-radius:8px;margin-left:6px}
.ret-note{color:var(--muted);font-style:italic}
.tag{display:inline-block;padding:3px 9px;border-radius:10px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.tag-crop{background:var(--tag-crop);color:#7fd47a}
.tag-mined{background:var(--tag-mined);color:#f0b060}
.tag-chopped{background:var(--tag-chopped);color:#60c898}
.tag-crafted{background:var(--tag-crafted);color:#60a8e0}
.tag-fishing{background:var(--tag-fishing);color:#60d0e0}
.tag-gathered{background:var(--tag-gathered);color:#b0d060}
.tag-retired{background:var(--tag-retired);color:#e08080}
.tag-other{background:var(--tag-other);color:#9090b0}
.tag-animal{background:var(--tag-animal);color:#c8e860}
.tag-seed{background:var(--tag-seed);color:#60e8a0}
.iid{font-family:monospace;font-size:13px;color:var(--muted)}
.rs{color:var(--muted);font-size:14px}
.mb{color:#7c5cfc;font-size:13px;margin-left:4px}
.lv{font-weight:600}
.lt{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:5px;text-transform:uppercase;letter-spacing:.5px}
.lt-water{background:#0d3a5c;color:#60d8ff}
.lt-grass{background:#1a3d1a;color:#78e878}
.lt-space{background:#1a0a3a;color:#c878ff}
@media(max-width:640px){
  header h1{font-size:22px}
  .controls input{flex:1 1 100%}
  .mr td{padding:11px 10px;font-size:15px}
}
</style>
</head>
<body>
<header>
  <h1>Pixels Catalog</h1>
  <div class="meta">Library v${escAttr(String(libVer))} · Updated ${updatedAt} · ${totalCount} items · Data from Pixels Online · updated automatically</div>
</header>
<div class="controls">
  <input type="search" id="search" placeholder="Search name or item ID…" autocomplete="off" spellcheck="false">
  <select id="fCat"><option value="">All categories</option>${categories.map((c) => `<option value="${escAttr(c)}">${escAttr(c === "retired" ? "Retired / event" : c)}</option>`).join("")}</select>
  <select id="fInd"><option value="">All industries</option>${industries.map((i) => `<option value="${escAttr(i)}">${escAttr(i)}</option>`).join("")}</select>
  <select id="fTier"><option value="0">All tiers</option>${tiers.map((t) => `<option value="${t}">Tier ${t}</option>`).join("")}</select>
</div>
<div class="count-bar" id="countBar">Showing all ${totalCount} items</div>
<div class="error-bar" id="errorBar"></div>
<div class="table-wrap">
<table id="tbl">
<thead><tr>
  <th data-col="n">Name</th>
  <th data-col="cat">Category</th>
  <th data-col="ind">Industry</th>
  <th data-col="t">Tier</th>
  <th data-col="lv">Level</th>
  <th data-col="tm">Time</th>
  <th data-col="en">Energy</th>
  <th data-col="xp">XP</th>
  <th data-col="s7d" title="Estimated sales per day from listing purchasedQuantity data">Sold/day</th>
  <th data-col="rec" style="min-width:200px">Recipe / Source</th>
</tr></thead>
<tbody id="tbody"></tbody>
</table>
</div>
<script>
/* All item text (names, labels, sources) lives in DATA or LABELS via safeJsonForScript.
   No text values are ever interpolated into JS string literals in this block. */
var DATA=${safeJsonForScript(jsData)};
var LABELS=${safeJsonForScript(labelConfig)};
var sortCol="n",sortDir=1;
function fmtT(m){if(!m)return"—";var s=Math.round(m*60),h=Math.floor(s/3600),mm=Math.floor((s%3600)/60),ss=s%60;var r="";if(h)r+=h+"h ";if(mm||(h&&ss))r+=mm+"m ";if(ss&&!h)r+=ss+"s";return r.trim()||"<1s";}
var SKILL_LABELS={exploration:"Exploration",petcare:"Animal Care",farming:"Farming",mining:"Mining",forestry:"Forestry",crafting:"Crafting"};
function sklName(sk){return SKILL_LABELS[sk]||(sk?(sk.charAt(0).toUpperCase()+sk.slice(1)):"");}
function tagCls(cat,ind){
  if(cat==="gathered"){var im={fishing:"fishing",mine:"mined",forestry:"chopped","animal product":"animal"};return"tag tag-"+(im[ind]||"gathered");}
  var m={crop:"crop",crafted:"crafted",retired:"retired",seed:"seed"};
  return"tag tag-"+(m[cat]||"other");
}
function catLbl(cat,ind){
  if(cat==="gathered"){var lm={fishing:"Fishing",mine:"Mined",forestry:"Chopped","animal product":"Animal"};return lm[ind]||"gathered";}
  if(cat==="retired")return"retired/event";
  if(cat==="seed")return"seed";
  return cat||"—";
}
function rcCell(d){
  if(d.cat==="retired")return'<span class="rs">Retired / event</span>';
  if(d.cat==="seed")return'<span class="rs">Seed · '+LABELS.buckShop+(d.seed?" → "+d.seed:"")+"</span>";
  if(d.cat==="crop"){var s=d.seed?"Grown from "+d.seed:"Farming";if(d.grow)s+=" ("+fmtT(d.grow)+")";var ltag2=d.lt?'<span class="lt lt-'+d.lt.toLowerCase()+'">'+d.lt+'</span>':"";return'<span class="rs">'+s+"</span>"+ltag2;}
  if(d.cat==="gathered"){
    var ltag=d.lt?'<span class="lt lt-'+d.lt.toLowerCase()+'">'+d.lt+'</span>':"";

    if(d.ind==="fishing")return'<span class="rs">Fish · Exploration'+(d.lv?" lv"+d.lv:"")+"</span>";
    if(d.ind==="mine")return'<span class="rs">Mine'+(d.tt?" · "+d.tt+(d.tmt?" tier "+d.tmt+"+":""):"")+"</span>"+ltag;
    if(d.ind==="forestry")return'<span class="rs">Chop'+(d.tt?" · "+d.tt+(d.tmt?" tier "+d.tmt+"+":""):"")+"</span>";
    if(d.ind==="animal product")return'<span class="rs">'+(d.sta||"Animal Care")+(d.lv>0?" · Animal Care lv"+d.lv:"")+"</span>";
    return'<span class="rs">Gather'+(d.ind?" ("+d.ind+")":" ")+"</span>";
  }
  if(d.rec){
    var r="<span>"+d.rec+"</span>";
    if(d.sta)r+='<span class="rs"> @ '+d.sta+"</span>";
    if(d.oqty>1)r+=" → "+d.oqty+"x";
    if(d.ev)r+='<span class="ev">event</span>';
    if(d.ars>1)r+='<span class="mb">+'+(d.ars-1)+" more</span>";
    return r;
  }
  return'<span class="rs">—</span>';
}
function tmCell(d){if(d.cat==="crafted")return d.tm?fmtT(d.tm):"—";if(d.cat==="crop")return d.grow?fmtT(d.grow):"—";return"—";}
function enCell(d){if(d.cat==="crafted")return d.en?d.en:"—";if(d.cat==="crop")return(d.pe||d.he)?(d.pe+d.he):"—";return"—";}
function xpCell(d){if(d.cat==="crafted")return d.xp?d.xp:"—";if(d.cat==="crop")return d.hxp?d.hxp:"—";return"—";}
function buildDetail(d){
  var h='<div class="dp"><div class="dp-id">'+d.id+'</div>';
  if(d.cat==="retired"){
    h+='<span class="ret-note">Not craftable at the moment — old recipe or event item that may return.</span>';
  }else if(d.cat==="seed"){
    h+='<div class="rb"><div class="sr">';
    h+="<span><b>Source:</b> "+LABELS.buckShop+"</span>";
    if(d.seed)h+="<span><b>Plants:</b> "+d.seed+"</span>";
    if(d.grow)h+="<span><b>Grow time:</b> "+fmtT(d.grow)+"</span>";
    if(d.lv)h+="<span><b>Farming level:</b> "+d.lv+"</span>";
    h+="</div></div>";
  }else if(d.cat==="crop"){
    h+='<div class="rb">';
    if(d.seed)h+="<div><b>Seed:</b> "+d.seed+"</div>";
    h+='<div class="sr">';
    if(d.grow)h+="<span><b>Grow time:</b> "+fmtT(d.grow)+"</span>";
    if(d.pe)h+="<span><b>Plant energy:</b> "+d.pe+"</span>";
    if(d.he)h+="<span><b>Harvest energy:</b> "+d.he+"</span>";
    if(d.hxp)h+="<span><b>XP per harvest:</b> "+d.hxp+"</span>";
    if(d.lv)h+="<span><b>Level required:</b> "+d.lv+"</span>";
    if(d.tt)h+="<span><b>Tool:</b> "+d.tt+(d.tmt?" tier "+d.tmt+"+":"")+"</span>";
    if(d.lt)h+='<span><b>Land required:</b> <span class="lt lt-'+d.lt.toLowerCase()+'">'+d.lt+'</span></span>';
    h+="</div></div>";
  }else if(d.cat==="gathered"){
    h+='<div class="rb"><div class="sr">';
    if(d.sk)h+="<span><b>Skill:</b> "+sklName(d.sk)+"</span>";
    if(d.sta){var isAnimal=d.sta.indexOf("Animal:")===0;h+="<span><b>Source:</b> "+d.sta+(isAnimal?" (placed on land)":"")+"</span>";}
    if(d.lv)h+="<span><b>Level required:</b> "+d.lv+"</span>";
    if(d.tt)h+="<span><b>Tool:</b> "+d.tt+(d.tmt?" tier "+d.tmt+"+":"  (any tier)")+"</span>";
    if(d.ind)h+="<span><b>Type:</b> "+d.ind+"</span>";
    if(d.lt)h+='<span><b>Land required:</b> <span class="lt lt-'+d.lt.toLowerCase()+'">'+d.lt+'</span></span>';
    if(d.sid&&d.ind==="animal product")h+='<span style="font-family:monospace;font-size:12px;color:var(--muted)">entity: '+d.sid+'</span>';
    h+="</div></div>";
  }else if(d.cat==="crafted"){
    if(!d.ar){
      h+='<div class="rb">';
      if(d.sta)h+='<div class="rl">@ '+d.sta+"</div>";
      if(d.rec){h+='<div class="il">';d.rec.split("; ").forEach(function(s){h+='<span class="ing">'+s+'</span>';});h+="</div>";}
      h+='<div class="sr">';
      if(d.oqty>1)h+="<span><b>Output:</b> "+d.oqty+"×</span>";
      if(d.tm)h+="<span><b>Time:</b> "+fmtT(d.tm)+"</span>";
      if(d.en)h+="<span><b>Energy:</b> "+d.en+"</span>";
      if(d.xp)h+="<span><b>XP:</b> "+d.xp+"</span>";
      if(d.lv)h+="<span><b>Level:</b> "+d.lv+"</span>";
      if(d.ev)h+='<span class="ev">event</span>';
      h+="</div></div>";
    }else{
      try{
        var rs=JSON.parse(d.ar);
        for(var i=0;i<rs.length;i++){
          var r=rs[i];
          h+='<div class="rb"><div class="rl">Recipe '+(i+1)+(r.station?" · @ "+r.station:"")+(r.isEvent?'<span class="ev">event</span>':"")+"</div>";
          if(r.inputs&&r.inputs.length){h+='<div class="il">';for(var j=0;j<r.inputs.length;j++)h+='<span class="ing">'+r.inputs[j].qty+"× "+r.inputs[j].name+'</span>';h+="</div>";}
          h+='<div class="sr">';
          if(r.outputQty>1)h+="<span><b>Output:</b> "+r.outputQty+"×</span>";
          if(r.craftTimeMinutes)h+="<span><b>Time:</b> "+fmtT(r.craftTimeMinutes)+"</span>";
          if(r.energy)h+="<span><b>Energy:</b> "+r.energy+"</span>";
          if(r.craftXp)h+="<span><b>XP:</b> "+r.craftXp+"</span>";
          if(r.levelRequired)h+="<span><b>Level:</b> "+r.levelRequired+"</span>";
          h+="</div></div>";
        }
      }catch(e){h+='<span class="rs">Recipe data unavailable.</span>';}
    }
  }else{
    h+='<span class="rs">No details available.</span>';
  }
  h+="</div>";return h;
}
function renderRows(data){
  var tb=document.getElementById("tbody");
  if(!tb)return;
  var html="";
  for(var i=0;i<data.length;i++){
    try{
      var d=data[i],idx=DATA.indexOf(d);
      html+='<tr class="mr" data-idx="'+idx+'">';
      html+='<td><div>'+d.n+(d.ars>1?'<span class="mb"> · '+(d.ars-1)+" alt</span>":"")+'</div><div class="iid">'+d.id+'</div></td>';
      html+='<td><span class="'+tagCls(d.cat,d.ind)+'">'+catLbl(d.cat,d.ind)+'</span></td>';
      html+="<td>"+(d.ind||"—")+"</td>";
      html+="<td>"+(d.t>0?d.t:"—")+"</td>";
      html+='<td>'+(d.lv>0?'<span class="lv">'+d.lv+'</span>':"—")+'</td>';
      html+="<td>"+tmCell(d)+"</td>";
      html+="<td>"+enCell(d)+"</td>";
      html+="<td>"+xpCell(d)+"</td>";
      html+='<td>'+(d.s7d!=null&&d.s7d>0?'~'+d.s7d.toFixed(d.s7d>=10?0:1)+'/d':"—")+'</td>';
      html+="<td>"+rcCell(d)+"</td>";
      html+="</tr>";
      html+='<tr class="dr" id="dr'+idx+'" style="display:none"><td colspan="9"></td></tr>';
    }catch(e){console.error("[catalog] row render error",data[i]&&data[i].id,e);}
  }
  tb.innerHTML=html;
  var cb=document.getElementById("countBar");
  if(cb)cb.textContent="Showing "+data.length+" of "+DATA.length+" items";
  document.querySelectorAll(".mr").forEach(function(tr){
    tr.addEventListener("click",function(){
      var idx=parseInt(this.getAttribute("data-idx"),10);
      var dr=document.getElementById("dr"+idx);
      if(!dr)return;
      var wasOpen=dr.style.display!=="none";
      document.querySelectorAll(".dr").forEach(function(r){r.style.display="none";});
      document.querySelectorAll(".mr").forEach(function(r){r.classList.remove("open");});
      if(!wasOpen){try{dr.querySelector("td").innerHTML=buildDetail(DATA[idx]);}catch(e){dr.querySelector("td").textContent="Error: "+e.message;}dr.style.display="";this.classList.add("open");}
    });
  });
}
function filtered(){
  var q=(document.getElementById("search")||{value:""}).value.toLowerCase().trim();
  var cat=(document.getElementById("fCat")||{value:""}).value;
  var ind=(document.getElementById("fInd")||{value:""}).value;
  var tier=parseInt((document.getElementById("fTier")||{value:"0"}).value,10)||0;
  var d=DATA;
  if(q)d=d.filter(function(r){return(r.n||"").toLowerCase().indexOf(q)>=0||(r.id||"").toLowerCase().indexOf(q)>=0;});
  if(cat)d=d.filter(function(r){return r.cat===cat;});
  if(ind)d=d.filter(function(r){return r.ind===ind;});
  if(tier)d=d.filter(function(r){return r.t===tier;});
  return d;
}
function sorted(d){
  var c=sortCol,dir=sortDir;
  return d.slice().sort(function(a,b){
    var av=a[c],bv=b[c];
    if(av==null)av="";if(bv==null)bv="";
    if(typeof av==="number"&&typeof bv==="number")return(av-bv)*dir;
    return String(av).localeCompare(String(bv))*dir;
  });
}
var _errorBar=document.getElementById("errorBar");
function refresh(){
  try{renderRows(sorted(filtered()));}
  catch(e){
    if(_errorBar){_errorBar.textContent="Render error: "+e.message;_errorBar.style.display="";}
    console.error("[catalog] refresh error",e);
  }
}
document.getElementById("search").addEventListener("input",refresh);
document.getElementById("fCat").addEventListener("change",refresh);
document.getElementById("fInd").addEventListener("change",refresh);
document.getElementById("fTier").addEventListener("change",refresh);
document.querySelectorAll("th[data-col]").forEach(function(th){
  th.addEventListener("click",function(){
    var c=th.getAttribute("data-col");
    if(sortCol===c){sortDir*=-1;}else{sortCol=c;sortDir=1;}
    document.querySelectorAll("th").forEach(function(t){t.className="";});
    th.className=sortDir===1?"sorted-asc":"sorted-desc";
    refresh();
  });
});
refresh();
</script>
</body>
</html>`;
}

router.get("/catalog", async (_req: Request, res: Response) => {
  try {
    await ensureCatalog();
    const meta         = getCatalogMeta();
    const rows         = listCatalogRows();
    const marketPrices = getAllMarketPrices();
    const html         = buildHtmlPage(rows, meta, true, marketPrices);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>${String(err)}</pre>`);
  }
});

// ---------------------------------------------------------------------------
// GET /debug/catalog  — shows items hidden from the public page.
//   /debug/catalog?category=unknown  → only null-category items
//   /debug/catalog                   → all items (no category filter)
// ---------------------------------------------------------------------------

router.get("/debug/catalog", async (req: Request, res: Response) => {
  try {
    await ensureCatalog();
    const meta = getCatalogMeta();
    const allRows = listCatalogRows();
    const catFilter    = req.query.category as string | undefined;
    const rows         = catFilter === "unknown"
      ? allRows.filter((r) => r.category === null)
      : allRows;
    const marketPrices = getAllMarketPrices();
    const html         = buildHtmlPage(rows, meta, false, marketPrices);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>${String(err)}</pre>`);
  }
});

export default router;
