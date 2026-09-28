import "dotenv/config";
import { createApp } from "./app";
import { startCrawler } from "./services/crawler";
import { startLocaleRefresh } from "./services/gameLibrary";
import { rebuildCatalogIfNeeded } from "./services/gameCatalog";
import { loadStaticData } from "./db/database";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log(`pixels-assistant listening on port ${PORT}`);
  loadStaticData();
  startCrawler();
  startLocaleRefresh();
  // Build game catalog on startup and refresh every 24 h
  rebuildCatalogIfNeeded().then(r => console.log(`[catalog] ${r.message}`)).catch(console.warn);
  setInterval(() => {
    rebuildCatalogIfNeeded().then(r => console.log(`[catalog] ${r.message}`)).catch(console.warn);
  }, 24 * 60 * 60_000);
});
