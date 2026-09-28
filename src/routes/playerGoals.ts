import { Router, Request, Response } from "express";
import {
  insertGoal,
  listActiveGoals,
  updateGoalStatus,
  getGoalById,
} from "../db/database";

const router = Router();

// GET /api/player/:walletAddress/goals — all active goals, most recent first
router.get("/api/player/:walletAddress/goals", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress is required" }); return; }

  res.json(listActiveGoals(walletAddress));
});

// POST /api/player/:walletAddress/goals — add a new goal
router.post("/api/player/:walletAddress/goals", (req: Request, res: Response) => {
  const { walletAddress } = req.params;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress is required" }); return; }

  const { goal_text } = req.body as Record<string, unknown>;
  if (typeof goal_text !== "string" || goal_text.trim() === "") {
    res.status(400).json({ error: "goal_text must be a non-empty string" }); return;
  }

  const row = insertGoal(walletAddress, goal_text.trim());
  res.status(201).json(row);
});

// PATCH /api/player/:walletAddress/goals/:id — update status
router.patch("/api/player/:walletAddress/goals/:id", (req: Request, res: Response) => {
  const { walletAddress, id } = req.params;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress is required" }); return; }

  const goalId = parseInt(id, 10);
  if (!Number.isInteger(goalId) || goalId <= 0) {
    res.status(400).json({ error: "id must be a positive integer" }); return;
  }

  const { status } = req.body as Record<string, unknown>;
  if (typeof status !== "string" || !["active", "done", "dropped"].includes(status)) {
    res.status(400).json({ error: "status must be 'active', 'done', or 'dropped'" }); return;
  }

  const existing = getGoalById(goalId);
  if (!existing || existing.wallet_address !== walletAddress) {
    res.status(404).json({ error: "not_found" }); return;
  }

  const updated = updateGoalStatus(goalId, status);
  res.json(updated);
});

export default router;
