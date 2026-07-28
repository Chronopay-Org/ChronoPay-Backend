import { randomUUID } from "crypto";
import { Counter, Histogram, Registry } from "prom-client";
import express from "express";
import { fileURLToPath } from "url";
import { getRedisClient } from "../src/cache/redisClient.js";
const isMainModule = typeof process !== 'undefined' && process.argv[1] === fileURLToPath(import.meta.url);
export const register = new Registry();
export const canarySuccessCounter = new Counter({
    name: "canary_booking_flow_success_total",
    help: "Total number of successful canary booking flows",
    registers: [register],
});
export const canaryFailureCounter = new Counter({
    name: "canary_booking_flow_failure_total",
    help: "Total number of failed canary booking flows",
    registers: [register],
});
export const canaryLatencyHistogram = new Histogram({
    name: "canary_booking_flow_latency_seconds",
    help: "Latency of the canary booking flow in seconds",
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
});
const API_URL = process.env.API_URL || "http://localhost:3001/api/v1";
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_KEY = "canary:tenant_lock";
const STALE_KEY = "canary:stale_intent";
const getCanaryAuthHeader = () => "Bearer canary-token-123";
async function cleanupStaleArtifacts() {
    const redis = getRedisClient();
    if (!redis)
        return;
    try {
        const staleId = await redis.get(STALE_KEY);
        if (staleId) {
            console.log(`[Canary] Found stale intent ${staleId}, cleaning up...`);
            await fetch(`${API_URL}/booking-intents/${staleId}/cancel`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: getCanaryAuthHeader(),
                },
            });
            await redis.del(STALE_KEY);
        }
    }
    catch (err) {
        console.error(`[Canary] Error cleaning up stale artifacts:`, err);
    }
}
export async function runCanary() {
    const redis = getRedisClient();
    if (redis) {
        // Acquire lock for 4.5 minutes to prevent overlap
        const locked = await redis.set(LOCK_KEY, "1", "EX", 270, "NX");
        if (!locked) {
            console.log(`[Canary] Tenant is locked by another probe. Skipping.`);
            return;
        }
    }
    await cleanupStaleArtifacts();
    const end = canaryLatencyHistogram.startTimer();
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 10000); // 10s probe timeout
    let createdIntentId = null;
    try {
        const slotId = `slot-${randomUUID()}`;
        // 1. Create Booking Intent
        const createIntentRes = await fetch(`${API_URL}/booking-intents`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: getCanaryAuthHeader(),
            },
            body: JSON.stringify({
                slotId,
                note: "Synthetic canary booking",
            }),
            signal: abortController.signal,
        });
        if (!createIntentRes.ok)
            throw new Error(`Failed to create intent: ${createIntentRes.status}`);
        const intentData = await createIntentRes.json();
        createdIntentId = intentData.intent?.id;
        if (!createdIntentId)
            throw new Error("No intent ID returned");
        if (redis) {
            // Mark as stale in case we crash before cancelling
            await redis.set(STALE_KEY, createdIntentId, "EX", 600);
        }
        // 2. Confirm Booking Intent
        const confirmRes = await fetch(`${API_URL}/booking-intents/${createdIntentId}/confirm`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: getCanaryAuthHeader(),
            },
            signal: abortController.signal,
        });
        if (!confirmRes.ok)
            throw new Error(`Failed to confirm intent: ${confirmRes.status}`);
        // 3. Cancel Booking Intent
        const cancelRes = await fetch(`${API_URL}/booking-intents/${createdIntentId}/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: getCanaryAuthHeader(),
            },
            signal: abortController.signal,
        });
        if (!cancelRes.ok)
            throw new Error(`Failed to cancel intent: ${cancelRes.status}`);
        if (redis)
            await redis.del(STALE_KEY); // Clean up the stale marker
        canarySuccessCounter.inc();
        end(); // Records latency
        console.log(`[${new Date().toISOString()}] Canary flow succeeded.`);
    }
    catch (error) {
        canaryFailureCounter.inc();
        console.error(`[${new Date().toISOString()}] Canary flow failed:`, error.message);
    }
    finally {
        clearTimeout(timeoutId);
        if (redis)
            await redis.del(LOCK_KEY);
    }
}
if (isMainModule || process.env.RUN_CANARY_SERVER === "true") {
    const app = express();
    app.get("/metrics", async (req, res) => {
        try {
            res.set("Content-Type", register.contentType);
            res.end(await register.metrics());
        }
        catch (ex) {
            res.status(500).end(String(ex));
        }
    });
    const port = process.env.METRICS_PORT || 3002;
    app.listen(port, () => {
        console.log(`Canary metrics server listening on port ${port}`);
        runCanary();
        setInterval(runCanary, INTERVAL_MS);
    });
}
