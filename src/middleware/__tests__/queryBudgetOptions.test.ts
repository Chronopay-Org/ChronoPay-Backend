// src/middleware/__tests__/queryBudgetOptions.test.ts
// Additional test coverage for edge cases
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { createQueryBudgetMiddleware } from "../queryBudget.js";
import { getQueryBudgetContext } from "../../db/queryBudgetContext.js";

function createApp(budgetMs?: number) {
  const app = express();
  app.use(express.json());
  app.use(createQueryBudgetMiddleware({ budgetMs }));

  app.get("/capture", (_req: Request, res: Response) => {
    const ctx = getQueryBudgetContext();
    res.json({
      budgetMs: ctx?.budgetMs,
      totalSqlTimeMs: ctx?.totalSqlTimeMs,
      breached: ctx?.breached,
    });
  });

  app.use((_err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, error: "Internal error" });
  });

  return app;
}

describe("queryBudget middleware options", () => {
  it("uses explicit positive budgetMs when provided", async () => {
    const app = createApp(5000);
    const response = await request(app).get("/capture");
    expect(response.status).toBe(200);
    expect(response.body.budgetMs).toBe(5000);
  });

  it("falls back to default when budgetMs is undefined", async () => {
    const app = createApp();
    const response = await request(app).get("/capture");
    expect(response.status).toBe(200);
    expect(response.body.budgetMs).toBe(30000);
  });

  it("ignores zero budgetMs and uses default", async () => {
    const app = createApp(0);
    const response = await request(app).get("/capture");
    expect(response.status).toBe(200);
    expect(response.body.budgetMs).toBe(30000);
  });

  it("ignores negative budgetMs and uses default", async () => {
    const app = createApp(-1000);
    const response = await request(app).get("/capture");
    expect(response.status).toBe(200);
    expect(response.body.budgetMs).toBe(30000);
  });
});
