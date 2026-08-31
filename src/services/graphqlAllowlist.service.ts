import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Counter } from "prom-client";
import { logger } from "../utils/logger.js";


export const rejectedAdhocQueries = new Counter({
  name: "graphql_rejected_adhoc_queries_total",
  help: "Total number of rejected ad-hoc GraphQL queries",
});

export class GraphqlAllowlistService {
  private allowlist: Record<string, string> = {};

  constructor(allowlistPath?: string) {
    if (allowlistPath) {
      this.loadAllowlist(allowlistPath);
    }
  }

  public loadAllowlist(allowlistPath: string) {
    try {
      const data = fs.readFileSync(allowlistPath, "utf-8");
      const parsed = JSON.parse(data);
      this.allowlist = parsed.queries || {};
    } catch (err) {
      logger.error({ err }, "Failed to load GraphQL allowlist");
      // Retain the old allowlist if parsing fails or clear it? 
      // Safe to not mutate on failure. But tests might want us to handle this gracefully.
    }
  }

  public isAllowed(hash: string): boolean {
    return !!this.allowlist[hash];
  }

  public hashQuery(query: string): string {
    return crypto.createHash("sha256").update(query).digest("hex");
  }

  public recordRejection() {
    rejectedAdhocQueries.inc();
  }
}

const defaultPath = path.join(process.cwd(), "src/config/graphql-allowlist.json");
export const graphqlAllowlistService = new GraphqlAllowlistService(defaultPath);
