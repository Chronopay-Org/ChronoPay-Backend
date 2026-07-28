import request from "supertest";
import { createApp } from "../../app.js";
import { graphqlAllowlistService, rejectedAdhocQueries } from "../../services/graphqlAllowlist.service.js";
import fs from "fs";
import path from "path";
import { register } from "prom-client";

const app = createApp();

describe("GraphQL Persisted Query Allowlist", () => {
  const allowlistPath = path.join(process.cwd(), "src/config/graphql-allowlist-test.json");

  beforeAll(() => {
    fs.writeFileSync(allowlistPath, JSON.stringify({
      queries: {
        "valid-hash-1": "query Test { test }",
        "valid-hash-2": "mutation TestMut { testMut }"
      }
    }));
    graphqlAllowlistService.loadAllowlist(allowlistPath);
  });

  afterAll(() => {
    if (fs.existsSync(allowlistPath)) {
      fs.unlinkSync(allowlistPath);
    }
    register.clear();
  });

  beforeEach(() => {
    rejectedAdhocQueries.reset();
  });

  it("should allow a valid persisted query hash directly", async () => {
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ hash: "valid-hash-1" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should allow a valid persisted query hash from extensions", async () => {
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ extensions: { persistedQuery: { sha256Hash: "valid-hash-2" } } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should reject an unknown hash and emit a metric", async () => {
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ hash: "unknown-hash" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Persisted query hash not in allowlist");
    
    const metrics = await register.metrics();
    expect(metrics).toContain("graphql_rejected_adhoc_queries_total 1");
  });

  it("should reject an ad-hoc query (no hash) and emit a metric", async () => {
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ query: "query { test }" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Ad-hoc queries are not allowed");

    const metrics = await register.metrics();
    expect(metrics).toContain("graphql_rejected_adhoc_queries_total 1");
  });
  
  it("should reject an ad-hoc query even if it is implicitly hashed and not in allowlist", async () => {
    // If a query is passed but it does not match a known hash, it should be rejected.
    // In our implementation, we hash the query implicitly.
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ query: "query { unknown }" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Ad-hoc queries are not allowed");
  });

  
  it("should accept a query if its hash matches the allowlist (implicit matching)", async () => {
    // Let's compute a hash for an allowed query and add it.
    const implicitHash = graphqlAllowlistService.hashQuery("query { implicit }");
    fs.writeFileSync(allowlistPath, JSON.stringify({
      queries: {
        [implicitHash]: "query { implicit }"
      }
    }));
    graphqlAllowlistService.loadAllowlist(allowlistPath);
    
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({ query: "query { implicit }" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should handle a completely invalid request", async () => {
    const res = await request(app)
      .post("/api/v1/graphql")
      .send({});
    expect(res.status).toBe(400);
  });

  it("should handle allowlist reload with invalid JSON gracefully", () => {
    // We expect the original allowlist to be retained because our catch block ignores the error
    fs.writeFileSync(allowlistPath, "invalid json");
    graphqlAllowlistService.loadAllowlist(allowlistPath);
    
    // It should still have the previously loaded allowlist
    const implicitHash = graphqlAllowlistService.hashQuery("query { implicit }");
    expect(graphqlAllowlistService.isAllowed(implicitHash)).toBe(true);
  });
  
  it("should handle the service constructor with an empty path", async () => {
    // Just for branch coverage
    const { GraphqlAllowlistService } = await import("../../services/graphqlAllowlist.service.js");
    const svc = new GraphqlAllowlistService();
    expect(svc.isAllowed("foo")).toBe(false);
  });

});
