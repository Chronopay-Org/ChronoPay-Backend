import {
  QueryBudgetContext,
  runWithQueryBudget,
  getQueryBudgetContext,
} from "../../db/queryBudgetContext";

describe("QueryBudgetContext", () => {
  it("should return undefined when outside of a budget context", () => {
    expect(getQueryBudgetContext()).toBeUndefined();
  });

  it("should return the context when inside runWithQueryBudget", () => {
    const context: QueryBudgetContext = {
      budgetMs: 1000,
      totalSqlTimeMs: 0,
      route: "/api/test",
      breached: false,
    };

    runWithQueryBudget(context, () => {
      const activeContext = getQueryBudgetContext();
      expect(activeContext).toBe(context);
      expect(activeContext?.budgetMs).toBe(1000);
      expect(activeContext?.route).toBe("/api/test");
    });
  });

  it("should support nested contexts independently", () => {
    const parentContext: QueryBudgetContext = {
      budgetMs: 1000,
      totalSqlTimeMs: 0,
      route: "/parent",
      breached: false,
    };

    const childContext: QueryBudgetContext = {
      budgetMs: 500,
      totalSqlTimeMs: 0,
      route: "/child",
      breached: false,
    };

    runWithQueryBudget(parentContext, () => {
      expect(getQueryBudgetContext()).toBe(parentContext);

      runWithQueryBudget(childContext, () => {
        expect(getQueryBudgetContext()).toBe(childContext);
      });

      // Context restores to parent after child finishes
      expect(getQueryBudgetContext()).toBe(parentContext);
    });
  });

  it("should isolate context between asynchronous operations", async () => {
    const context1: QueryBudgetContext = {
      budgetMs: 1000,
      totalSqlTimeMs: 0,
      route: "/route1",
      breached: false,
    };

    const context2: QueryBudgetContext = {
      budgetMs: 2000,
      totalSqlTimeMs: 0,
      route: "/route2",
      breached: false,
    };

    const op1 = runWithQueryBudget(context1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getQueryBudgetContext()).toBe(context1);
    });

    const op2 = runWithQueryBudget(context2, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getQueryBudgetContext()).toBe(context2);
    });

    await Promise.all([op1, op2]);

    expect(getQueryBudgetContext()).toBeUndefined();
  });

  it("should modify and persist state within the context", () => {
    const context: QueryBudgetContext = {
      budgetMs: 1000,
      totalSqlTimeMs: 0,
      route: "/state-test",
      breached: false,
    };

    runWithQueryBudget(context, () => {
      const activeContext = getQueryBudgetContext();
      if (activeContext) {
        activeContext.totalSqlTimeMs += 50;
        activeContext.breached = true;
      }
    });

    expect(context.totalSqlTimeMs).toBe(50);
    expect(context.breached).toBe(true);
  });
});
