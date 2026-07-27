import { Router, type Request, type Response, NextFunction } from "express";
import { graphqlAllowlistService } from "../services/graphqlAllowlist.service.js";
import crypto from "crypto";
import { createLoaders } from "../graphql/loaders.js";

const router = Router();

// Wire DataLoader batching per request
router.use((req: Request, res: Response, next: NextFunction) => {
  (req as any).loaders = createLoaders();
  next();
});

router.post("/", (req: Request, res: Response) => {
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
        data: { message: "Query allowed", operationName }
      });
    } else {
      graphqlAllowlistService.recordRejection();
      // If they provided a hash but it's unknown
      if (hash || extensions?.persistedQuery?.sha256Hash) {
        return res.status(403).json({
          success: false,
          error: "Persisted query hash not in allowlist"
        });
      } else {
        // They didn't provide a hash, so it was an ad-hoc query that failed the implicit hash check
        return res.status(403).json({ success: false, error: "Ad-hoc queries are not allowed" });
      }
    }
  }

  if (query) {
    graphqlAllowlistService.recordRejection();
    return res.status(403).json({ success: false, error: "Ad-hoc queries are not allowed" });
  }


  return res.status(400).json({ success: false, error: "Invalid GraphQL request" });
});

export default router;
