import { Router } from "express";
import healthRouter from "./health";
import askRouter from "./ask";
import landReportRouter from "./landReport";
import landSearchRouter from "./landSearch";
import playerStateRouter from "./playerState";
import playerGoalsRouter from "./playerGoals";
import skillThresholdsRouter from "./skillThresholds";
import craftEfficiencyRouter from "./craftEfficiency";
import catalogSearchRouter from "./catalogSearch";
import notebookRouter from "./notebook";
import catalogPublicRouter from "./catalogPublic";
import marketDataRouter from "./marketData";
import landReadyRouter from "./landReady";

const router = Router();

router.use(healthRouter);
router.use(askRouter);
router.use(landReportRouter);
router.use(landSearchRouter);
router.use(landReadyRouter);
router.use(playerStateRouter);
router.use(playerGoalsRouter);
router.use(skillThresholdsRouter);
router.use(craftEfficiencyRouter);
router.use(catalogSearchRouter);
router.use(notebookRouter);
router.use(catalogPublicRouter);
router.use(marketDataRouter);

export default router;
