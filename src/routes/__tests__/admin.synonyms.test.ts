import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { pool } from "../../db/pool.js";

const ADMIN_TOKEN = "synonym-test-admin-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

describe("Admin Synonym Registry Routes", () => {
  let app: express.Application;
  let mockSynonyms: any[] = [];
  let querySpy: any;

  beforeEach(() => {
    mockSynonyms = [
      { id: 1, word: "plumbing", synonyms: ["pipe", "drain"] }
    ];

    app = makeApp();

    if (querySpy) {
      querySpy.mockRestore();
    }

    querySpy = jest.spyOn(pool, "query").mockImplementation(async (sql: string, params: any[] = []): Promise<any> => {
      if (sql.includes("SELECT id, word, synonyms FROM search_synonyms ORDER BY id ASC")) {
        return { rows: [...mockSynonyms] };
      }
      if (sql.includes("SELECT id, word, synonyms FROM search_synonyms WHERE id = $1")) {
        const record = mockSynonyms.find((r) => r.id === params[0]);
        return { rows: record ? [record] : [] };
      }
      if (sql.includes("INSERT INTO search_synonyms")) {
        const record = { id: 2, word: params[0], synonyms: params[1] };
        mockSynonyms.push(record);
        return { rows: [record], rowCount: 1 };
      }
      if (sql.includes("UPDATE search_synonyms")) {
        const record = mockSynonyms.find((r) => r.id === params[2]);
        if (record) {
          record.word = params[0];
          record.synonyms = params[1];
          return { rows: [record], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM search_synonyms")) {
        const idx = mockSynonyms.findIndex((r) => r.id === params[0]);
        if (idx !== -1) {
          mockSynonyms.splice(idx, 1);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
  });

  describe("GET /api/v1/admin/synonyms", () => {
    it("requires admin token header", async () => {
      const res = await request(app).get("/api/v1/admin/synonyms");
      expect(res.status).toBe(401);
    });

    it("returns synonyms list when authorized", async () => {
      const res = await request(app)
        .get("/api/v1/admin/synonyms")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.synonyms).toHaveLength(1);
      expect(res.body.synonyms[0].word).toBe("plumbing");
    });
  });

  describe("POST /api/v1/admin/synonyms", () => {
    it("requires admin token", async () => {
      const res = await request(app)
        .post("/api/v1/admin/synonyms")
        .send({ word: "cleaning", synonyms: ["wash"] });
      expect(res.status).toBe(401);
    });

    it("creates a synonym mapping", async () => {
      const res = await request(app)
        .post("/api/v1/admin/synonyms")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ word: "cleaning", synonyms: ["wash", "sweep"] });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.synonym.word).toBe("cleaning");
      expect(res.body.synonym.synonyms).toEqual(["wash", "sweep"]);
    });

    it("validates bad input schema", async () => {
      const res = await request(app)
        .post("/api/v1/admin/synonyms")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ word: "", synonyms: [] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("PUT /api/v1/admin/synonyms/:id", () => {
    it("updates synonym mapping", async () => {
      const res = await request(app)
        .put("/api/v1/admin/synonyms/1")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ word: "plumbing", synonyms: ["pipe", "leak"] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.synonym.synonyms).toEqual(["pipe", "leak"]);
    });

    it("returns 404 if not found", async () => {
      const res = await request(app)
        .put("/api/v1/admin/synonyms/999")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ word: "plumbing" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/admin/synonyms/:id", () => {
    it("deletes synonym mapping", async () => {
      const res = await request(app)
        .delete("/api/v1/admin/synonyms/1")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 if not found", async () => {
      const res = await request(app)
        .delete("/api/v1/admin/synonyms/999")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(404);
    });
  });
});
