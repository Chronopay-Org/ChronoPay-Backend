import { describe, it, expect } from "@jest/globals";
import {
  estimateQueryCost,
  validateQueryCost,
  GraphQLCostError,
  DEFAULT_BUDGET,
} from "../graphqlCostEstimator.js";

describe("estimateQueryCost", () => {
  it("estimates a simple query with minimal cost", () => {
    const result = estimateQueryCost("query { me { id name } }");
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.operationType).toBe("query");
    expect(result.fields.length).toBeGreaterThan(0);
  });

  it("detects mutation operation type", () => {
    const result = estimateQueryCost(
      "mutation { createBooking(input: { slotId: \"1\" }) { id status } }",
    );
    expect(result.operationType).toBe("mutation");
  });

  it("detects subscription operation type", () => {
    const result = estimateQueryCost(
      "subscription { onBookingConfirmed { id status } }",
    );
    expect(result.operationType).toBe("subscription");
  });

  it("defaults to query when no operation keyword", () => {
    const result = estimateQueryCost("{ me { id } }");
    expect(result.operationType).toBe("query");
  });

  it("handles deeply nested fields with higher cost", () => {
    const shallow = estimateQueryCost("{ a { b } }");
    const deep = estimateQueryCost("{ a { b { c { d } } } }");
    expect(deep.totalCost).toBeGreaterThan(shallow.totalCost);
  });

  it("handles queries with arguments", () => {
    const result = estimateQueryCost(
      "query { slot(id: \"abc\", date: \"2026-01-01\") { id } }",
    );
    // Should have at least one field with 2 arguments
    const slotField = result.fields.find((f) => f.name === "slot");
    expect(slotField).toBeDefined();
  });

  it("handles commented lines gracefully", () => {
    const result = estimateQueryCost(`
      # This is a comment
      query {
        me {
          id  # inline comment
          name
        }
      }
    `);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.operationType).toBe("query");
  });

  it("handles empty or whitespace query gracefully", () => {
    const result = estimateQueryCost("   ");
    expect(result.totalCost).toBe(0);
    expect(result.fields).toEqual([]);
  });

  it("handles fragment spreads", () => {
    const result = estimateQueryCost(`
      query {
        me { ...UserFields }
        recentSlots { ...SlotFields }
      }
      fragment UserFields on User { id name email }
      fragment SlotFields on Slot { id title price }
    `);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.fields.length).toBeGreaterThan(0);
  });
});

describe("validateQueryCost", () => {
  it("allows a query within budget", () => {
    const result = validateQueryCost("{ me { id } }");
    expect(result.allowed).toBe(true);
    expect(result.totalCost).toBeLessThanOrEqual(result.budget);
  });

  it("rejects a query exceeding query budget", () => {
    const tinyBudget = { ...DEFAULT_BUDGET, maxQueryCost: 1 };
    expect(() => {
      validateQueryCost("{ a { b { c { d { e } } } } }", tinyBudget);
    }).toThrow(GraphQLCostError);
  });

  it("includes cost and budget in the error", () => {
    const tinyBudget = { ...DEFAULT_BUDGET, maxQueryCost: 1 };
    try {
      validateQueryCost("{ a { b { c } } }", tinyBudget);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      if (err instanceof GraphQLCostError) {
        expect(err.cost).toBeGreaterThan(0);
        expect(err.budget).toBe(1);
        expect(err.statusCode).toBe(403);
        expect(err.code).toBe("GRAPHQL_COST_EXCEEDED");
      } else {
        throw err;
      }
    }
  });

  it("uses a different budget for mutations", () => {
    const result = validateQueryCost(
      "mutation { createBooking(input: { slotId: \"1\" }) { id } }",
    );
    expect(result.allowed).toBe(true);
    expect(result.budget).toBe(DEFAULT_BUDGET.maxMutationCost);
  });

  it("rejects a deep query over budget", () => {
    const moderateBudget = { ...DEFAULT_BUDGET, maxQueryCost: 5 };
    expect(() => {
      validateQueryCost(
        "{ a { b { c { d { e { f { g } } } } } } }",
        moderateBudget,
      );
    }).toThrow(GraphQLCostError);
  });

  it("GraphQLCostError has correct toJSON output", () => {
    const err = new GraphQLCostError("Over budget", 150, 100);
    const json = err.toJSON();
    expect(json.error).toBe("Over budget");
    expect(json.code).toBe("GRAPHQL_COST_EXCEEDED");
    expect(json.cost).toBe(150);
    expect(json.budget).toBe(100);
  });
});
