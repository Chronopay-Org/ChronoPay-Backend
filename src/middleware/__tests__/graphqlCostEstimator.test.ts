import { describe, it, expect } from "@jest/globals";
import {
  estimateQueryCost,
  validateQueryCost,
  GraphQLCostError,
  DEFAULT_BUDGET,
  type CostBudget,
  type CostResult,
} from "../graphqlCostEstimator.js";

describe("CostBudget & DEFAULT_BUDGET Configuration", () => {
  it("exposes DEFAULT_BUDGET with expected baseline thresholds", () => {
    expect(DEFAULT_BUDGET).toEqual({
      maxQueryCost: 100,
      maxMutationCost: 200,
      maxSubscriptionCost: 500,
    });
  });

  it("supports creating custom CostBudget configurations", () => {
    const customBudget: CostBudget = {
      maxQueryCost: 25,
      maxMutationCost: 50,
      maxSubscriptionCost: 150,
    };

    expect(customBudget.maxQueryCost).toBe(25);
    expect(customBudget.maxMutationCost).toBe(50);
    expect(customBudget.maxSubscriptionCost).toBe(150);
  });
});

describe("GraphQLCostError", () => {
  it("instantiates with cost, budget, message, and standard error metadata", () => {
    const err = new GraphQLCostError("Query cost exceeded limit", 120.5, 100);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GraphQLCostError);
    expect(err.name).toBe("GraphQLCostError");
    expect(err.message).toBe("Query cost exceeded limit");
    expect(err.cost).toBe(120.5);
    expect(err.budget).toBe(100);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("GRAPHQL_COST_EXCEEDED");
  });

  it("serializes to JSON format correctly via toJSON", () => {
    const err = new GraphQLCostError("Operation rejected", 250, 200);
    const json = err.toJSON();

    expect(json).toEqual({
      error: "Operation rejected",
      code: "GRAPHQL_COST_EXCEEDED",
      cost: 250,
      budget: 200,
    });
  });

  it("is fully serializable and stringifiable", () => {
    const err = new GraphQLCostError("Cost violation", 75, 50);
    const serialized = JSON.stringify(err.toJSON());
    const parsed = JSON.parse(serialized);

    expect(parsed.error).toBe("Cost violation");
    expect(parsed.code).toBe("GRAPHQL_COST_EXCEEDED");
    expect(parsed.cost).toBe(75);
    expect(parsed.budget).toBe(50);
  });
});

describe("estimateQueryCost", () => {
  describe("operation type extraction", () => {
    it("identifies standard query operations", () => {
      const explicitQuery = estimateQueryCost("query GetMe { me { id } }");
      expect(explicitQuery.operationType).toBe("query");

      const implicitQuery = estimateQueryCost("{ me { id } }");
      expect(implicitQuery.operationType).toBe("query");
    });

    it("identifies mutation operations with casing variations", () => {
      const explicitMutation = estimateQueryCost(
        'mutation CreateBooking { createBooking(slotId: "1") { id } }',
      );
      expect(explicitMutation.operationType).toBe("mutation");

      const uppercaseMutation = estimateQueryCost("MUTATION { cancelBooking { id } }");
      expect(uppercaseMutation.operationType).toBe("mutation");
    });

    it("identifies subscription operations with casing variations", () => {
      const explicitSubscription = estimateQueryCost(
        "subscription OnSlotBooked { onSlotBooked { id slotId } }",
      );
      expect(explicitSubscription.operationType).toBe("subscription");

      const uppercaseSubscription = estimateQueryCost("SUBSCRIPTION { streamUpdates { id } }");
      expect(uppercaseSubscription.operationType).toBe("subscription");
    });
  });

  describe("field cost computation rules", () => {
    it("calculates cost for top-level scalar fields", () => {
      // Top-level scalar: depth 1 -> cost = 1 * (1 + 1.5 * 0) = 1
      const result = estimateQueryCost("{ me }");
      expect(result.totalCost).toBe(1);
      expect(result.fields).toEqual([{ name: "me", cost: 1, depth: 1 }]);
    });

    it("applies depth penalty to nested scalar fields", () => {
      // me is depth 1 (cost = 1), id is depth 2 (cost = 1 * (1 + 1.5 * 1) = 2.5)
      // Total: 1 + 2.5 = 3.5
      const result = estimateQueryCost("{ me { id } }");
      expect(result.totalCost).toBe(3.5);
      expect(result.fields).toEqual([
        { name: "me", cost: 1, depth: 1 },
        { name: "id", cost: 2.5, depth: 2 },
      ]);
    });

    it("applies object multiplier when field directly precedes subfield brace", () => {
      // me{ has immediate brace -> depth 1 object: 1 * (1 + 0) * 2 = 2
      // id is depth 2 scalar: 2.5
      // Total: 2 + 2.5 = 4.5
      const result = estimateQueryCost("{ me{ id } }");
      expect(result.totalCost).toBe(4.5);
      expect(result.fields).toEqual([
        { name: "me", cost: 2, depth: 1 },
        { name: "id", cost: 2.5, depth: 2 },
      ]);
    });

    it("scales cost with increasing field depth penalty", () => {
      const shallow = estimateQueryCost("{ a { b } }");
      const deep = estimateQueryCost("{ a { b { c { d } } } }");
      expect(deep.totalCost).toBeGreaterThan(shallow.totalCost);

      const level3Field = deep.fields.find((f) => f.name === "c");
      const level4Field = deep.fields.find((f) => f.name === "d");
      expect(level4Field!.depth).toBe(4);
      expect(level3Field!.depth).toBe(3);
    });

    it("adds argument count for positional arguments without colon", () => {
      const noArgs = estimateQueryCost("{ slot { id } }");
      const withArgs = estimateQueryCost("{ slot(arg1, arg2) { id } }");

      expect(withArgs.totalCost).toBeGreaterThan(noArgs.totalCost);
      const slotField = withArgs.fields.find((f) => f.name === "slot");
      expect(slotField).toBeDefined();
      expect(slotField!.cost).toBe(3); // depth 1 cost (1) + 2 args = 3
    });

    it("detects list fields and applies list fanout multiplier", () => {
      const standardField = estimateQueryCost("{ items { id } }");
      const listField = estimateQueryCost("{ items[ { id } }");
      expect(listField.totalCost).toBeGreaterThan(standardField.totalCost);
    });

    it("applies list fanout multiplier when list bracket immediately follows field name", () => {
      const listObject = estimateQueryCost("{ items[{ id } }");
      // items has isList: true and depth 1 -> cost = 1 * 3 = 3
      // id has depth 2 -> cost = 2.5
      // Total: 3 + 2.5 = 5.5
      expect(listObject.totalCost).toBe(5.5);
      const itemsField = listObject.fields.find((f) => f.name === "items");
      expect(itemsField).toEqual({ name: "items", cost: 3, depth: 1 });
    });

    it("computes argument count via lookahead when space precedes parentheses", () => {
      const result = estimateQueryCost('{ search (query: "test", limit: 10, offset: 0) { id } }');
      const searchField = result.fields.find((f) => f.name === "search");
      expect(searchField).toBeDefined();
      expect(searchField?.cost).toBe(4); // depth 1 cost (1) + 3 arguments = 4
      expect(result.totalCost).toBe(6.5); // 4 + 2.5
    });

    it("handles nested parentheses inside argument list lookahead", () => {
      const result = estimateQueryCost(
        '{ search (filter: (nestedA, nestedB), sort: "asc") { id } }',
      );
      const searchField = result.fields.find((f) => f.name === "search");
      expect(searchField).toBeDefined();
      expect(searchField!.cost).toBeGreaterThan(1);
    });

    it("handles unclosed parentheses gracefully in lookahead", () => {
      const result = estimateQueryCost("{ search (unclosedQuery { id } }");
      const searchField = result.fields.find((f) => f.name === "search");
      expect(searchField).toBeDefined();
    });

    it("handles multiple sibling fields and aggregates total cost", () => {
      const result = estimateQueryCost("{ me { id name email } }");
      expect(result.fields.length).toBe(4);
      const expectedTotal = result.fields.reduce((acc, f) => acc + f.cost, 0);
      expect(result.totalCost).toBe(Math.round(expectedTotal * 100) / 100);
      expect(result.totalCost).toBe(8.5); // 1 + 2.5 + 2.5 + 2.5
    });
  });

  describe("representative invalid and edge-case inputs", () => {
    it("returns zero cost and empty fields for empty string", () => {
      const result = estimateQueryCost("");
      expect(result.totalCost).toBe(0);
      expect(result.fields).toEqual([]);
      expect(result.operationType).toBe("query");
    });

    it("returns zero cost and empty fields for whitespace-only strings", () => {
      const result = estimateQueryCost("   \n\t  \r\n ");
      expect(result.totalCost).toBe(0);
      expect(result.fields).toEqual([]);
      expect(result.operationType).toBe("query");
    });

    it("returns zero cost for comments-only query strings", () => {
      const lineCommentOnly = estimateQueryCost("# Just a comment\n# Another comment");
      expect(lineCommentOnly.totalCost).toBe(0);
      expect(lineCommentOnly.fields).toEqual([]);

      const blockCommentOnly = estimateQueryCost("/* Block comment only */");
      expect(blockCommentOnly.totalCost).toBe(0);
      expect(blockCommentOnly.fields).toEqual([]);
    });

    it("returns zero cost for invalid query missing opening brace", () => {
      const result = estimateQueryCost("query GetUserWithoutBraces");
      expect(result.totalCost).toBe(0);
      expect(result.fields).toEqual([]);
    });

    it("handles query ending abruptly after a field name", () => {
      const result = estimateQueryCost("{ me");
      expect(result.totalCost).toBe(0);
      expect(result.fields).toEqual([]);
    });

    it("filters GraphQL keywords so they are not counted as fields", () => {
      const queryWithKeywords = estimateQueryCost(`
        query MyQuery {
          user {
            id
            type
          }
        }
        fragment UserDetails on User {
          email
        }
      `);

      const fieldNames = queryWithKeywords.fields.map((f) => f.name);
      expect(fieldNames).not.toContain("query");
      expect(fieldNames).not.toContain("fragment");
      expect(fieldNames).not.toContain("on");
      expect(fieldNames).toContain("user");
      expect(fieldNames).toContain("id");
      expect(fieldNames).toContain("email");
    });

    it("handles inline and block comments within queries seamlessly", () => {
      const result = estimateQueryCost(`
        query {
          me { /* inline block comment */
            id # trailing field comment
            name
          }
        }
      `);
      expect(result.totalCost).toBeGreaterThan(0);
      expect(result.operationType).toBe("query");
      const fieldNames = result.fields.map((f) => f.name);
      expect(fieldNames).toContain("me");
      expect(fieldNames).toContain("id");
      expect(fieldNames).toContain("name");
    });
  });
});

describe("validateQueryCost", () => {
  describe("query operation budget enforcement", () => {
    it("returns CostResult with allowed: true when query is well within budget", () => {
      const result: CostResult = validateQueryCost("{ me { id } }");
      expect(result.allowed).toBe(true);
      expect(result.budget).toBe(DEFAULT_BUDGET.maxQueryCost);
      expect(result.totalCost).toBe(3.5);
      expect(result.totalCost).toBeLessThanOrEqual(result.budget);
    });

    it("allows query when totalCost exactly equals maxQueryCost (exact boundary)", () => {
      const exactBudget: CostBudget = {
        maxQueryCost: 3.5,
        maxMutationCost: 200,
        maxSubscriptionCost: 500,
      };

      const result = validateQueryCost("{ me { id } }", exactBudget);
      expect(result.allowed).toBe(true);
      expect(result.totalCost).toBe(3.5);
      expect(result.budget).toBe(3.5);
    });

    it("throws GraphQLCostError when query cost exceeds maxQueryCost by smallest increment", () => {
      const tightBudget: CostBudget = {
        maxQueryCost: 3.49,
        maxMutationCost: 200,
        maxSubscriptionCost: 500,
      };

      try {
        validateQueryCost("{ me { id } }", tightBudget);
        expect(true).toBe(false); // Should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(GraphQLCostError);
        const costErr = err as GraphQLCostError;
        expect(costErr.statusCode).toBe(403);
        expect(costErr.code).toBe("GRAPHQL_COST_EXCEEDED");
        expect(costErr.cost).toBe(3.5);
        expect(costErr.budget).toBe(3.49);
        expect(costErr.message).toBe("Query cost 3.5 exceeds query budget of 3.49");
      }
    });

    it("rejects highly nested queries that exceed default maxQueryCost", () => {
      // Build deeply nested query to exceed default budget of 100
      let deepQuery = "field0";
      for (let i = 1; i <= 30; i++) {
        deepQuery = `field${i} { ${deepQuery} }`;
      }
      deepQuery = `{ ${deepQuery} }`;

      expect(() => validateQueryCost(deepQuery)).toThrow(GraphQLCostError);
    });
  });

  describe("mutation operation budget enforcement", () => {
    it("allows mutation within maxMutationCost using DEFAULT_BUDGET", () => {
      const mutation = 'mutation { createBooking(slotId: "1", userId: "2") { id status } }';
      const result = validateQueryCost(mutation);

      expect(result.allowed).toBe(true);
      expect(result.budget).toBe(DEFAULT_BUDGET.maxMutationCost);
      expect(result.totalCost).toBeLessThanOrEqual(DEFAULT_BUDGET.maxMutationCost);
    });

    it("allows mutation when cost exactly equals maxMutationCost boundary", () => {
      const mutation = "mutation { updateStatus { id } }";
      const { totalCost } = estimateQueryCost(mutation);

      const exactBudget: CostBudget = {
        maxQueryCost: 10,
        maxMutationCost: totalCost,
        maxSubscriptionCost: 500,
      };

      const result = validateQueryCost(mutation, exactBudget);
      expect(result.allowed).toBe(true);
      expect(result.totalCost).toBe(totalCost);
      expect(result.budget).toBe(totalCost);
    });

    it("throws GraphQLCostError when mutation exceeds maxMutationCost", () => {
      const mutation = 'mutation { createBooking(slotId: "1") { id status } }';
      const { totalCost } = estimateQueryCost(mutation);

      const tightBudget: CostBudget = {
        maxQueryCost: 100,
        maxMutationCost: totalCost - 1,
        maxSubscriptionCost: 500,
      };

      expect(() => validateQueryCost(mutation, tightBudget)).toThrow(GraphQLCostError);

      try {
        validateQueryCost(mutation, tightBudget);
      } catch (err) {
        const costErr = err as GraphQLCostError;
        expect(costErr.budget).toBe(tightBudget.maxMutationCost);
        expect(costErr.message).toContain(
          `exceeds mutation budget of ${tightBudget.maxMutationCost}`,
        );
      }
    });
  });

  describe("subscription operation budget enforcement", () => {
    it("allows subscription within maxSubscriptionCost using DEFAULT_BUDGET", () => {
      const subscription = "subscription { onSlotBooked { id slotId timestamp } }";
      const result = validateQueryCost(subscription);

      expect(result.allowed).toBe(true);
      expect(result.budget).toBe(DEFAULT_BUDGET.maxSubscriptionCost);
      expect(result.totalCost).toBeLessThanOrEqual(DEFAULT_BUDGET.maxSubscriptionCost);
    });

    it("allows subscription when cost exactly equals maxSubscriptionCost boundary", () => {
      const subscription = "subscription { streamData { value } }";
      const { totalCost } = estimateQueryCost(subscription);

      const exactBudget: CostBudget = {
        maxQueryCost: 10,
        maxMutationCost: 20,
        maxSubscriptionCost: totalCost,
      };

      const result = validateQueryCost(subscription, exactBudget);
      expect(result.allowed).toBe(true);
      expect(result.totalCost).toBe(totalCost);
      expect(result.budget).toBe(totalCost);
    });

    it("throws GraphQLCostError when subscription exceeds maxSubscriptionCost", () => {
      const subscription = "subscription { streamData { value } }";
      const { totalCost } = estimateQueryCost(subscription);

      const tightBudget: CostBudget = {
        maxQueryCost: 100,
        maxMutationCost: 200,
        maxSubscriptionCost: totalCost - 0.5,
      };

      expect(() => validateQueryCost(subscription, tightBudget)).toThrow(GraphQLCostError);

      try {
        validateQueryCost(subscription, tightBudget);
      } catch (err) {
        const costErr = err as GraphQLCostError;
        expect(costErr.budget).toBe(tightBudget.maxSubscriptionCost);
        expect(costErr.message).toContain(
          `exceeds subscription budget of ${tightBudget.maxSubscriptionCost}`,
        );
      }
    });
  });

  describe("custom budget overrides and zero-budget state transitions", () => {
    it("handles zero query budget: permits 0-cost empty query but rejects non-empty query", () => {
      const zeroBudget: CostBudget = {
        maxQueryCost: 0,
        maxMutationCost: 0,
        maxSubscriptionCost: 0,
      };

      // Empty query has totalCost = 0, which satisfies <= 0
      const emptyResult = validateQueryCost("", zeroBudget);
      expect(emptyResult.allowed).toBe(true);
      expect(emptyResult.totalCost).toBe(0);
      expect(emptyResult.budget).toBe(0);

      // Non-empty query has totalCost > 0 and must fail
      expect(() => validateQueryCost("{ me }", zeroBudget)).toThrow(GraphQLCostError);
    });

    it("applies distinct custom budgets to different operations seamlessly", () => {
      const customBudget: CostBudget = {
        maxQueryCost: 5,
        maxMutationCost: 10,
        maxSubscriptionCost: 25,
      };

      const query = "{ me { id } }"; // cost 3.5 <= 5 (passes)
      // Build mutation that costs more than 10
      const expensiveMutation = "mutation { a { b { c { d { e { f } } } } } }";

      expect(validateQueryCost(query, customBudget).allowed).toBe(true);
      expect(() => validateQueryCost(expensiveMutation, customBudget)).toThrow(GraphQLCostError);
    });
  });
});
