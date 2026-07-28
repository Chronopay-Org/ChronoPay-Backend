/**
 * GraphQL query-cost estimator
 *
 * Scores incoming GraphQL queries and rejects requests over a configured
 * budget per token type. Each field in the query contributes to the total
 * cost based on its depth, type (object vs scalar), and whether it introduces
 * list fan-out.
 *
 * The estimator parses the raw query string to produce a cost estimate.
 * Budget is configurable per token type.
 */

// ---- Types -------------------------------------------------------------------

export interface CostBudget {
  /** Maximum allowed cost for a single query */
  maxQueryCost: number;
  /** Maximum allowed cost for a mutation */
  maxMutationCost: number;
  /** Maximum allowed cost for a subscription */
  maxSubscriptionCost: number;
}

export interface CostResult {
  /** Estimated total cost score */
  totalCost: number;
  /** Whether this query fits within its budget */
  allowed: boolean;
  /** Human-readable reason if rejected */
  reason?: string;
  /** Per-operation budget applied */
  budget: number;
}

export class GraphQLCostError extends Error {
  readonly statusCode = 403;
  readonly code = "GRAPHQL_COST_EXCEEDED";

  constructor(
    message: string,
    public readonly cost: number,
    public readonly budget: number,
  ) {
    super(message);
    this.name = "GraphQLCostError";
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      cost: this.cost,
      budget: this.budget,
    };
  }
}

// ---- Default budgets ---------------------------------------------------------

export const DEFAULT_BUDGET: CostBudget = {
  maxQueryCost: 100,
  maxMutationCost: 200,
  maxSubscriptionCost: 500,
};

// ---- Token type cost weights -------------------------------------------------

const FIELD_BASE_COST = 1;
const OBJECT_FIELD_MULTIPLIER = 2;
const LIST_FANOUT_MULTIPLIER = 3;
const DEPTH_PENALTY = 1.5;

// ---- Helpers -----------------------------------------------------------------

type OperationType = "query" | "mutation" | "subscription";

/**
 * Very simple GraphQL query parser that extracts field names, depth,
 * and detects list fields. This is intentionally not a full GraphQL parser;
 * it uses regex analysis that covers the common patterns in the codebase.
 *
 * For production, consider using `graphql` package's `parse()` + AST visitor.
 */

interface ParsedField {
  name: string;
  depth: number;
  isList: boolean;
  hasSubfields: boolean;
  /** Arguments present on this field */
  argCount: number;
}

/** Parse a GraphQL operation string and extract all fields with depth info. */
function parseQueryFields(
  query: string,
): { operationType: OperationType; fields: ParsedField[] } {
  const operationType = extractOperationType(query);
  const fields: ParsedField[] = [];

  // Remove comments
  const cleaned = query
    .replace(/#.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  if (!cleaned) return { operationType, fields: [] };

  // Strip everything before the first `{` (operation keyword, params, etc.)
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return { operationType, fields: [] };

  const body = cleaned.slice(firstBrace);

  // Track field names and their depth by scanning character by character
  let depth = 0;
  let currentField = "";
  let inArgParens = 0;
  let currentArgCount = 0;
  let seenOpeningBraceForField = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (ch === "(") {
      inArgParens++;
      continue;
    }
    if (ch === ")") {
      inArgParens--;
      // Count arguments: split the inner content by commas
      if (inArgParens === 0 && currentField) {
        const argStart = body.lastIndexOf("(", i);
        if (argStart !== -1) {
          const argContent = body.slice(argStart + 1, i);
          currentArgCount = argContent
            .split(",")
            .filter((a) => a.trim().length > 0 && !a.includes(":"))
            .length;
        }
      }
      continue;
    }

    if (inArgParens > 0) continue;

    // Track field name characters
    if (/[a-zA-Z_]/.test(ch)) {
      currentField += ch;
      continue;
    }

    // When we hit a non-name character after accumulating a field name
    if (currentField) {
      const isKeyword = [
        "query", "mutation", "subscription", "fragment", "on",
        "type", "interface", "true", "false", "null",
      ].includes(currentField);

      if (!isKeyword) {
        const nextCh = body[i] || " ";
        const hasSubfields = nextCh === "{";
        const isNextList = nextCh === "[";

        // Look ahead for arguments if we haven't counted them yet
        const afterField = body.slice(i).trimStart();
        let argCount = currentArgCount;
        if (afterField.startsWith("(")) {
          const closeParen = findMatchingParen(body, i + afterField.indexOf("("));
          if (closeParen !== -1) {
            const argContent = body.slice(i + afterField.indexOf("(") + 1, closeParen);
            argCount = argContent
              .split(",")
              .filter((a) => a.trim().length > 0)
              .length;
          }
        }

        fields.push({
          name: currentField,
          depth: depth,
          isList: isNextList,
          hasSubfields,
          argCount,
        });
      }
      currentField = "";
      currentArgCount = 0;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }

  return { operationType, fields };
}

/** Find the matching closing parenthesis for an opening paren at startPos. */
function findMatchingParen(str: string, startPos: number): number {
  let depth = 0;
  for (let i = startPos; i < str.length; i++) {
    if (str[i] === "(") depth++;
    if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractOperationType(query: string): OperationType {
  const cleaned = query.trim().replace(/#.*$/gm, "").replace(/\s+/g, " ");
  if (/^mutation\b/i.test(cleaned)) return "mutation";
  if (/^subscription\b/i.test(cleaned)) return "subscription";
  return "query";
}

/**
 * Compute a cost score for a parsed set of fields.
 *
 * Cost formula:
 *   fieldCost = BASE_COST × (1 + DEPTH_PENALTY × depth)
 *   if object type: × OBJECT_FIELD_MULTIPLIER
 *   if list: × LIST_FANOUT_MULTIPLIER
 *   + argCount (each argument adds 1 cost unit)
 */
function computeFieldCost(field: ParsedField): number {
  let cost = FIELD_BASE_COST * (1 + DEPTH_PENALTY * (field.depth - 1));

  if (field.hasSubfields) {
    cost *= OBJECT_FIELD_MULTIPLIER;
  }

  if (field.isList) {
    cost *= LIST_FANOUT_MULTIPLIER;
  }

  cost += field.argCount;

  return Math.round(cost * 100) / 100;
}

/**
 * Estimate the cost of a GraphQL query string.
 */
export function estimateQueryCost(query: string): {
  totalCost: number;
  fields: Array<{ name: string; cost: number; depth: number }>;
  operationType: OperationType;
} {
  const { operationType, fields } = parseQueryFields(query);

  const fieldCosts = fields.map((f) => ({
    name: f.name,
    cost: computeFieldCost(f),
    depth: f.depth,
  }));

  const totalCost = fieldCosts.reduce((sum, f) => sum + f.cost, 0);

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    fields: fieldCosts,
    operationType,
  };
}

/**
 * Validate that a query is within budget, throwing if exceeded.
 */
export function validateQueryCost(
  query: string,
  budget: CostBudget = DEFAULT_BUDGET,
): CostResult {
  const { totalCost, operationType } = estimateQueryCost(query);

  const budgetMap: Record<OperationType, number> = {
    query: budget.maxQueryCost,
    mutation: budget.maxMutationCost,
    subscription: budget.maxSubscriptionCost,
  };

  const allowedBudget = budgetMap[operationType];

  if (totalCost > allowedBudget) {
    throw new GraphQLCostError(
      `Query cost ${totalCost} exceeds ${operationType} budget of ${allowedBudget}`,
      totalCost,
      allowedBudget,
    );
  }

  return { totalCost, allowed: true, budget: allowedBudget };
}
