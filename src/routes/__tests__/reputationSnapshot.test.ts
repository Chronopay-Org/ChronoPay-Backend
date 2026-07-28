/**
 * Tests for daily reputation snapshots (#458)
 *
 * Covers:
 *  - runSnapshotJob: writes rows, idempotency (conflict skipped), missed-day backfill
 *  - computeTierLabel: tier boundary logic
 *  - listReputationSnapshots: filtering, pagination, newest-first
 *  - HTTP: POST /api/v1/admin/reputation/snapshots/run
 *  - HTTP: GET  /api/v1/admin/reputation/snapshots
 *  - Edge cases: timezone drift (date is always UTC), duplicate runs
 */

import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import {
  runSnapshotJob,
  listReputationSnapshots,
  computeTierLabel,
  DEFAULT_TIER_BOUNDARIES,
  _resetSnapshotStore,
} from "../../services/reputationSnapshotService.js";

const ADMIN_TOKEN = "snapshot-test-admin-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

beforeEach(() => {
  _resetSnapshotStore();
});

// ─── Unit: computeTierLabel ───────────────────────────────────────────────────

describe("computeTierLabel()", () => {
  it("returns excellent for score >= excellent boundary", () => {
    expect(computeTierLabel(90, DEFAULT_TIER_BOUNDARIES)).toBe("excellent");
    expect(computeTierLabel(100, DEFAULT_TIER_BOUNDARIES)).toBe("excellent");
  });

  it("returns good for score >= good boundary", () => {
    expect(computeTierLabel(70, DEFAULT_TIER_BOUNDARIES)).toBe("good");
    expect(computeTierLabel(89, DEFAULT_TIER_BOUNDARIES)).toBe("good");
  });

  it("returns needs_improvement for score >= needs_improvement boundary", () => {
    expect(computeTierLabel(50, DEFAULT_TIER_BOUNDARIES)).toBe("needs_improvement");
    expect(computeTierLabel(69, DEFAULT_TIER_BOUNDARIES)).toBe("needs_improvement");
  });

  it("returns poor for score below needs_improvement boundary", () => {
    expect(computeTierLabel(49, DEFAULT_TIER_BOUNDARIES)).toBe("poor");
    expect(computeTierLabel(0, DEFAULT_TIER_BOUNDARIES)).toBe("poor");
  });
});

// ─── Unit: runSnapshotJob ─────────────────────────────────────────────────────

describe("runSnapshotJob()", () => {
  const suppliers = [
    { supplierId: "sup-1", score: 92 },
    { supplierId: "sup-2", score: 71 },
    { supplierId: "sup-3", score: 48 },
  ];

  it("writes one snapshot per supplier", async () => {
    const result = await runSnapshotJob(suppliers);
    expect(result.written).toBe(3);
    expect(result.skipped).toBe(0);
    const { snapshots } = await listReputationSnapshots({});
    expect(snapshots).toHaveLength(3);
  });

  it("skips duplicate runs for the same date (idempotency)", async () => {
    const date = new Date("2025-07-01T00:00:00.000Z");
    const first = await runSnapshotJob(suppliers, date);
    const second = await runSnapshotJob(suppliers, date);
    expect(first.written).toBe(3);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it("stores the correct tier label", async () => {
    const date = new Date("2025-07-01T00:00:00.000Z");
    await runSnapshotJob(suppliers, date);
    const { snapshots } = await listReputationSnapshots({ supplierId: "sup-1" });
    expect(snapshots[0].tierLabel).toBe("excellent");
    const { snapshots: s2 } = await listReputationSnapshots({ supplierId: "sup-2" });
    expect(s2[0].tierLabel).toBe("good");
    const { snapshots: s3 } = await listReputationSnapshots({ supplierId: "sup-3" });
    expect(s3[0].tierLabel).toBe("needs_improvement");
  });

  it("records tier_boundaries in each snapshot", async () => {
    const date = new Date("2025-07-01T00:00:00.000Z");
    await runSnapshotJob(suppliers, date);
    const { snapshots } = await listReputationSnapshots({ supplierId: "sup-1" });
    expect(snapshots[0].tierBoundaries).toEqual(DEFAULT_TIER_BOUNDARIES);
  });

  it("stores snapshot_date as a YYYY-MM-DD UTC string", async () => {
    const date = new Date("2025-07-04T22:30:00.000Z");
    await runSnapshotJob([{ supplierId: "sup-tz", score: 80 }], date);
    const { snapshots } = await listReputationSnapshots({ supplierId: "sup-tz" });
    // UTC date: 2025-07-04, not 2025-07-05 (timezone drift guard)
    expect(snapshots[0].snapshotDate).toBe("2025-07-04");
  });

  it("supports missed-day backfill by passing a historical date", async () => {
    const missedDay = new Date("2025-06-15T00:00:00.000Z");
    const result = await runSnapshotJob(suppliers, missedDay);
    expect(result.snapshotDate).toBe("2025-06-15");
    expect(result.written).toBe(3);
  });

  it("returns a consistent jobRunId for all rows in a single run", async () => {
    const date = new Date("2025-07-01T00:00:00.000Z");
    const result = await runSnapshotJob(suppliers, date);
    const { snapshots } = await listReputationSnapshots({});
    const jobRunIds = new Set(snapshots.map((s) => s.jobRunId));
    expect(jobRunIds.size).toBe(1);
    expect(jobRunIds.has(result.jobRunId)).toBe(true);
  });

  it("handles empty suppliers list gracefully", async () => {
    const result = await runSnapshotJob([]);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ─── Unit: listReputationSnapshots ───────────────────────────────────────────

describe("listReputationSnapshots()", () => {
  beforeEach(async () => {
    // Seed 3 days of snapshots for sup-1 and 2 days for sup-2
    for (let day = 1; day <= 3; day++) {
      await runSnapshotJob(
        [{ supplierId: "sup-1", score: 70 + day }],
        new Date(`2025-07-0${day}T00:00:00.000Z`),
      );
    }
    for (let day = 1; day <= 2; day++) {
      await runSnapshotJob(
        [{ supplierId: "sup-2", score: 60 + day }],
        new Date(`2025-07-0${day}T00:00:00.000Z`),
      );
    }
  });

  it("returns all snapshots when no filter is applied", async () => {
    const { total, snapshots } = await listReputationSnapshots({});
    expect(total).toBe(5);
    expect(snapshots).toHaveLength(5);
  });

  it("filters by supplierId", async () => {
    const { total } = await listReputationSnapshots({ supplierId: "sup-1" });
    expect(total).toBe(3);
  });

  it("returns results newest-first", async () => {
    const { snapshots } = await listReputationSnapshots({ supplierId: "sup-1" });
    for (let i = 0; i < snapshots.length - 1; i++) {
      expect(snapshots[i].snapshotDate >= snapshots[i + 1].snapshotDate).toBe(true);
    }
  });

  it("filters by since date", async () => {
    const { snapshots } = await listReputationSnapshots({
      supplierId: "sup-1",
      since: "2025-07-02",
    });
    expect(snapshots.every((s) => s.snapshotDate >= "2025-07-02")).toBe(true);
    expect(snapshots).toHaveLength(2);
  });

  it("filters by until date", async () => {
    const { snapshots } = await listReputationSnapshots({
      supplierId: "sup-1",
      until: "2025-07-02",
    });
    expect(snapshots.every((s) => s.snapshotDate <= "2025-07-02")).toBe(true);
    expect(snapshots).toHaveLength(2);
  });

  it("respects limit", async () => {
    const { snapshots } = await listReputationSnapshots({ limit: 2 });
    expect(snapshots).toHaveLength(2);
  });
});

// ─── HTTP: POST /reputation/snapshots/run ────────────────────────────────────

describe("POST /api/v1/admin/reputation/snapshots/run", () => {
  it("returns 401 without admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .send({ suppliers: [{ supplierId: "sup-1", score: 80 }] });
    expect(res.status).toBe(401);
  });

  it("returns 400 when suppliers is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when suppliers is empty array", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ suppliers: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a supplier has an invalid score", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ suppliers: [{ supplierId: "sup-1", score: "not-a-number" }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid snapshotDate", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ suppliers: [{ supplierId: "sup-1", score: 80 }], snapshotDate: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with written count on success", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ suppliers: [{ supplierId: "sup-1", score: 85 }, { supplierId: "sup-2", score: 60 }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.written).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.jobRunId).toBeDefined();
  });

  it("skips duplicate for same snapshotDate", async () => {
    const body = {
      suppliers: [{ supplierId: "sup-1", score: 85 }],
      snapshotDate: "2025-07-01",
    };
    await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send(body);

    const res2 = await request(makeApp())
      .post("/api/v1/admin/reputation/snapshots/run")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send(body);
    expect(res2.status).toBe(200);
    expect(res2.body.written).toBe(0);
    expect(res2.body.skipped).toBe(1);
  });
});

// ─── HTTP: GET /reputation/snapshots ─────────────────────────────────────────

describe("GET /api/v1/admin/reputation/snapshots", () => {
  beforeEach(async () => {
    await runSnapshotJob(
      [{ supplierId: "sup-a", score: 88 }, { supplierId: "sup-b", score: 55 }],
      new Date("2025-07-01T00:00:00.000Z"),
    );
    await runSnapshotJob(
      [{ supplierId: "sup-a", score: 89 }],
      new Date("2025-07-02T00:00:00.000Z"),
    );
  });

  it("returns 401 without admin token", async () => {
    const res = await request(makeApp()).get("/api/v1/admin/reputation/snapshots");
    expect(res.status).toBe(401);
  });

  it("returns all snapshots", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/reputation/snapshots")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it("filters by supplierId", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/reputation/snapshots?supplierId=sup-a")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.snapshots.every((s: { supplierId: string }) => s.supplierId === "sup-a")).toBe(true);
  });

  it("filters by since", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/reputation/snapshots?since=2025-07-02")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.snapshots.every((s: { snapshotDate: string }) => s.snapshotDate >= "2025-07-02")).toBe(true);
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/reputation/snapshots?limit=999")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });
});
