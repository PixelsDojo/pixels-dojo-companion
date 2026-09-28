import { Router, Request, Response } from "express";
import { upsertLandReport } from "../db/database";

const router = Router();

router.post("/api/land-report", (req: Request, res: Response) => {
  const { landId, observedAt, permissions, industries } = req.body as {
    landId?:      unknown;
    observedAt?:  unknown;
    permissions?: unknown;
    industries?:  unknown;
  };

  if (typeof landId !== "string" || !landId) {
    res.status(400).json({ error: "landId (string) is required" });
    return;
  }
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) {
    res.status(400).json({ error: "observedAt (number) is required" });
    return;
  }

  upsertLandReport({ landId, observedAt, permissions, industries });
  console.log(`[land-report] upserted land_id=${landId} observed_at=${observedAt}`);
  res.json({ ok: true });
});

export default router;
