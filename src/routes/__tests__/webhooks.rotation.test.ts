import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { registerWebhookRoutes } from "../webhooks.js";
import adminRouter from "../admin.js";

function signWithSecret(body: object, secret: string) {
    const raw = JSON.stringify(body);
    return createHmac("sha256", secret).update(raw).digest("hex");
}

function validPayload(overrides: Record<string, unknown> = {}) {
    return {
        eventType: "settlement_completed",
        transactionId: "txn-rot-001",
        amount: 100,
        timestamp: Date.now(),
        ...overrides,
    };
}

describe("webhook key rotation and admin promote", () => {
    afterEach(() => {
        delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
        delete process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;
        delete process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;
        delete process.env.CHRONOPAY_ADMIN_TOKEN;
    });

    it("accepts previous secret during overlap window and rejects it after window closes", async () => {
        const curr = "curr-secret";
        const prev = "prev-secret";

        process.env.SETTLEMENTS_WEBHOOK_SECRET = curr;
        process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS = prev;

        const app = express();
        app.use(
            express.json({
                verify: (req: any, _res, buf) => {
                    req.rawBody = buf;
                },
            }),
        );

        registerWebhookRoutes(app, {});

        const body = validPayload();
        const sigPrev = signWithSecret(body, prev);

        const resPrev = await request(app)
            .post("/api/v1/webhooks/settlements")
            .set("x-webhook-signature", sigPrev)
            .send(body);

        expect(resPrev.status).toBe(200);

        // Simulate overlap window closing
        delete process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;

        const resAfter = await request(app)
            .post("/api/v1/webhooks/settlements")
            .set("x-webhook-signature", sigPrev)
            .send(body);

        expect(resAfter.status).toBe(403);
    });

    it("admin promote endpoint promotes NEXT to CURRENT and sets PREVIOUS", async () => {
        process.env.SETTLEMENTS_WEBHOOK_SECRET = "old-current";
        process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT = "new-current";
        process.env.CHRONOPAY_ADMIN_TOKEN = "admintoken";

        const adminApp = express();
        adminApp.use(express.json());
        adminApp.use("/api/v1/admin", adminRouter);

        const res = await request(adminApp)
            .post("/api/v1/admin/webhooks/rotate")
            .set("x-chronopay-admin-token", "admintoken")
            .send();

        expect(res.status).toBe(200);
        expect(process.env.SETTLEMENTS_WEBHOOK_SECRET).toBe("new-current");
        expect(process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS).toBe("old-current");
        expect(process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT).toBeUndefined();
    });
});
