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

  public loadAllowlist(allowlistPath: string): boolean {
    try {
      const data = fs.readFileSync(allowlistPath, "utf-8");
      const parsed = JSON.parse(data);
      this.allowlist = parsed.queries || {};
      return true;
    } catch (err) {
      logger.error({ err, path: allowlistPath }, "Failed to load GraphQL allowlist");
      // Retain the previous allowlist on failure (safe to not mutate on failure)
      return false;
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

// Build default path from import.meta.url with env override
const defaultPath = new URL(
  "../config/graphql-allowlist.json",
  import.meta.url
).pathname;
export const GRAPHQL_ALLOWLIST_PATH = process.env.GRAPHQL_ALLOWLIST_PATH;

export const graphqlAllowlistService = new GraphqlAllowlistService(
  GRAPHQL_ALLOWLIST_PATH || defaultPath
);