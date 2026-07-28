import { Router, type Request, type Response, NextFunction } from "express";
import { graphqlAllowlistService } from "../services/graphqlAllowlist.service.js";
import crypto from "crypto";
import { createLoaders } from "../graphql/loaders.js";
import {
  validateQueryCost,
  GraphQLCostError,
  DEFAULT_BUDGET,
  estimateQueryCost,
  type CostBudget,
} from "../middleware/graphqlCostEstimator.js";
import { register } from "prom-client";

const router = Router();

// Prometheus counter for cost-based rejections
const costRejectionsCounter = new register.Counter({
  name: "graphql_cost_rejection_total",
  help: "Total number of GraphQL queries rejected due to cost exceeding budget",
  labelNames: ["operation_type"] as const,
});

// Prometheus histogram for query cost distribution
const queryCostHistogram = new register.Histogram({
  name: "graphql_query_cost",
  help: "Distribution of estimated GraphQL query costs",
  labelNames: ["operation_type"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 200, 500, 1000],
});

/**
 * Middleware: estimate and validate query cost before processing.
 * Only applies when a raw query string is present.
 */
function costEstimator(budget: CostBudget = DEFAULT_BUDGET) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { query } = req.body;

    if (!query || typeof query !== "string") {
      return next(); // No query to estimate; let router handle it
    }

    try {
      const estimation = estimateQueryCost(query);
      queryCostHistogram
        .labels({ operation_type: estimation.operationType })
        .observe(estimation.totalCost);

      validateQueryCost(query, budget);

      // Attach cost info to request for downstream use
      (req as any).queryCost = estimation.totalCost;
      next();
    } catch (err) {
      if (err instanceof GraphQLCostError) {
        costRejectionsCounter
          .labels({ operation_type: extractOpType(query) })
          .inc();

        return res.status(err.statusCode).json(err.toJSON());
      }
      next(err);
    }
  };
}

function extractOpType(query: string): string {
  const cleaned = query.trim().replace(/#.*$/gm, "").replace(/\s+/g, " ");
  if (/^mutation\b/i.test(cleaned)) return "mutation";
  if (/^subscription\b/i.test(cleaned)) return "subscription";
  return "query";
}

// Wire DataLoader batching per request
router.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).loaders = createLoaders();
  next();
});

// Cost estimator middleware — runs before allowlist check
router.post("/", costEstimator(), (req: Request, res: Response) => {
  const { query, hash, operationName, extensions } = req.body;

  // Extract hash from Apollo APQ format if present
  let finalHash = hash;
  if (!finalHash && extensions?.persistedQuery?.sha256Hash) {
    finalHash = extensions.persistedQuery.sha256Hash;
  }

  if (!finalHash && query) {
    // Attempt to hash the incoming query to check if it's implicitly a persisted query
    finalHash = crypto.createHash("sha256").update(query).digest("hex");
  }

  if (finalHash) {
    if (graphqlAllowlistService.isAllowed(finalHash)) {
      return res.status(200).json({
        success: true,
        data: { message: "Query allowed", operationName },
        meta: (req as any).queryCost
          ? { estimatedCost: (req as any).queryCost }
          : undefined,
      });
    } else {
      graphqlAllowlistService.recordRejection();
      if (hash || extensions?.persistedQuery?.sha256Hash) {
        return res.status(403).json({
          success: false,
          error: "Persisted query hash not in allowlist",
        });
      } else {
        return res.status(403).json({
          success: false,
          error: "Ad-hoc queries are not allowed",
        });
      }
    }
  }

  if (query) {
    graphqlAllowlistService.recordRejection();
    return res.status(403).json({
      success: false,
      error: "Ad-hoc queries are not allowed",
    });
  }

  return res.status(400).json({
    success: false,
    error: "Invalid GraphQL request",
  });
});

export default router;
