/**
 * PlanService - Persistent storage for agent plans
 *
 * Plans are stored in SQLite and associated with chatId so:
 * - Plans persist across app restarts
 * - Agent can resume where it left off
 * - Multiple plans can exist per chat
 * - Plan history is maintained
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

export interface Plan {
  planId: string;
  chatId: string;
  title: string;
  steps: PlanStep[];
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

let planServiceInstance: PlanService | null = null;

export class PlanService {
  private paprRootDir: string;
  private dbPath: string;
  private db: Database.Database | null = null;
  private initialized: boolean = false;

  constructor() {
    const homeDir = os.homedir();
    this.paprRootDir = path.join(homeDir, "PAPR");
    this.dbPath = path.join(this.paprRootDir, "data", "plans.db");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure data directory exists
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    // Open database
    this.db = new Database(this.dbPath);

    // Create plans table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        steps TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plans_chat_id ON plans(chat_id);
      CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
      CREATE INDEX IF NOT EXISTS idx_plans_chat_status ON plans(chat_id, status);
    `);

    this.initialized = true;
    console.log("[PlanService] Initialized");
  }

  /**
   * Create a new plan
   */
  async createPlan(
    planId: string,
    chatId: string,
    title: string,
    steps: PlanStep[],
  ): Promise<Plan> {
    if (!this.db) throw new Error("PlanService not initialized");

    const now = new Date().toISOString();
    const plan: Plan = {
      planId,
      chatId,
      title,
      steps,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO plans (plan_id, chat_id, title, steps, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      plan.planId,
      plan.chatId,
      plan.title,
      JSON.stringify(plan.steps),
      plan.status,
      plan.createdAt,
      plan.updatedAt,
    );

    console.log(`[PlanService] Created plan: ${planId} for chat: ${chatId}`);
    return plan;
  }

  /**
   * Update plan steps
   */
  async updatePlan(planId: string, steps: PlanStep[]): Promise<Plan | null> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      UPDATE plans
      SET steps = ?, updated_at = ?
      WHERE plan_id = ?
    `);

    const now = new Date().toISOString();
    const result = stmt.run(JSON.stringify(steps), now, planId);

    if (result.changes === 0) {
      return null;
    }

    return this.getPlan(planId);
  }

  /**
   * Mark plan as completed or cancelled
   */
  async updatePlanStatus(
    planId: string,
    status: "active" | "completed" | "cancelled",
  ): Promise<Plan | null> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      UPDATE plans
      SET status = ?, updated_at = ?
      WHERE plan_id = ?
    `);

    const now = new Date().toISOString();
    const result = stmt.run(status, now, planId);

    if (result.changes === 0) {
      return null;
    }

    return this.getPlan(planId);
  }

  /**
   * Get a specific plan
   */
  async getPlan(planId: string): Promise<Plan | null> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      SELECT * FROM plans WHERE plan_id = ?
    `);

    const row = stmt.get(planId) as any;
    if (!row) return null;

    return {
      planId: row.plan_id,
      chatId: row.chat_id,
      title: row.title,
      steps: JSON.parse(row.steps),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Get all plans for a chat
   */
  async getPlansForChat(chatId: string): Promise<Plan[]> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      SELECT * FROM plans
      WHERE chat_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(chatId) as any[];

    return rows.map((row) => ({
      planId: row.plan_id,
      chatId: row.chat_id,
      title: row.title,
      steps: JSON.parse(row.steps),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get active plans for a chat (status = 'active')
   */
  async getActivePlansForChat(chatId: string): Promise<Plan[]> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      SELECT * FROM plans
      WHERE chat_id = ? AND status = 'active'
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(chatId) as any[];

    return rows.map((row) => ({
      planId: row.plan_id,
      chatId: row.chat_id,
      title: row.title,
      steps: JSON.parse(row.steps),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Delete a plan
   */
  async deletePlan(planId: string): Promise<boolean> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      DELETE FROM plans WHERE plan_id = ?
    `);

    const result = stmt.run(planId);
    return result.changes > 0;
  }

  /**
   * Delete all plans for a chat
   */
  async deletePlansForChat(chatId: string): Promise<number> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      DELETE FROM plans WHERE chat_id = ?
    `);

    const result = stmt.run(chatId);
    return result.changes;
  }

  /**
   * Get plan statistics for a chat
   */
  async getChatPlanStats(chatId: string): Promise<{
    total: number;
    active: number;
    completed: number;
    cancelled: number;
  }> {
    if (!this.db) throw new Error("PlanService not initialized");

    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM plans
      WHERE chat_id = ?
    `);

    const row = stmt.get(chatId) as any;

    return {
      total: row.total || 0,
      active: row.active || 0,
      completed: row.completed || 0,
      cancelled: row.cancelled || 0,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

/**
 * Get or create PlanService singleton
 */
export function getPlanService(): PlanService {
  if (!planServiceInstance) {
    planServiceInstance = new PlanService();
  }
  return planServiceInstance;
}

/**
 * Initialize PlanService
 */
export async function initializePlanService(): Promise<PlanService> {
  const service = getPlanService();
  await service.initialize();
  return service;
}
