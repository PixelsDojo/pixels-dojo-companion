import { Router, Request, Response } from "express";
import { getPlayerState, upsertPlayerState } from "../db/database";

const router = Router();

router.get("/api/player/:walletAddress/state", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress is required" }); return; }

  const row = getPlayerState(walletAddress);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }

  res.json(row);
});

router.post("/api/player/:walletAddress/state", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress is required" }); return; }

  const { goals, time_available, sociability_level, timezone, persona } = req.body as Record<string, unknown>;

  if (goals !== undefined && typeof goals !== "string") {
    res.status(400).json({ error: "goals must be a string" }); return;
  }
  if (time_available !== undefined && typeof time_available !== "string") {
    res.status(400).json({ error: "time_available must be a string" }); return;
  }
  if (
    sociability_level !== undefined &&
    (typeof sociability_level !== "number" || ![1, 2, 3, 4].includes(sociability_level))
  ) {
    res.status(400).json({ error: "sociability_level must be 1–4" }); return;
  }
  if (timezone !== undefined && typeof timezone !== "string") {
    res.status(400).json({ error: "timezone must be a string" }); return;
  }
  if (
    persona !== undefined &&
    (typeof persona !== "string" || !["pixin", "goat", "cat"].includes(persona))
  ) {
    res.status(400).json({ error: "persona must be 'pixin', 'goat', or 'cat'" }); return;
  }

  upsertPlayerState({
    walletAddress,
    goals:            goals            as string | undefined,
    timeAvailable:    time_available   as string | undefined,
    sociabilityLevel: sociability_level as number | undefined,
    timezone:         timezone         as string | undefined,
    persona:          persona          as string | undefined,
  });

  const updated = getPlayerState(walletAddress)!;
  res.json(updated);
});

export default router;
