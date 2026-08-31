/**
 * Subscription Routes API
 *
 * RESTful endpoints for subscription product and subscription management:
 * - POST   /api/v1/subscriptions/products              - Create product
 * - GET    /api/v1/subscriptions/products               - List products
 * - GET    /api/v1/subscriptions/products/:productId    - Get product
 * - DELETE /api/v1/subscriptions/products/:productId    - Deactivate product
 * - POST   /api/v1/subscriptions                        - Subscribe
 * - GET    /api/v1/subscriptions/:subscriptionId        - Get subscription
 * - POST   /api/v1/subscriptions/:subscriptionId/pause  - Pause
 * - POST   /api/v1/subscriptions/:subscriptionId/resume - Resume
 * - POST   /api/v1/subscriptions/:subscriptionId/cancel - Cancel
 */

import { Router, Request, Response } from "express";
import {
  SubscriptionService,
  SubscriptionProductNotFoundError,
  SubscriptionNotFoundError,
  DuplicateSubscriptionError,
  SubscriptionCapacityExceededError,
  InvalidSubscriptionStateError,
  SchedulingConflictError,
} from "../services/subscriptionService.js";
import {
  InMemorySubscriptionProductRepository,
} from "../modules/subscriptions/subscription-product-repository.js";
import {
  InMemorySubscriptionRepository,
} from "../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

// Singleton repositories (in production these would be SQL-backed)
const productRepo = new InMemorySubscriptionProductRepository();
const subscriptionRepo = new InMemorySubscriptionRepository();
const slotRepo = new InMemorySlotRepository();

export const subscriptionService = new SubscriptionService(
  productRepo,
  subscriptionRepo,
  slotRepo,
);

const router = Router();

// ── Product Endpoints ────────────────────────────────────────────────────────

router.post("/products", async (req: Request, res: Response) => {
  try {
    const { name, description, professional, slotDurationMs, recurrenceRule, timezone, priceCents, currency, maxSubscribers } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: "name is required" });
    }
    if (!professional || typeof professional !== "string" || professional.trim().length === 0) {
      return res.status(400).json({ success: false, error: "professional is required" });
    }
    if (typeof slotDurationMs !== "number" || slotDurationMs <= 0) {
      return res.status(400).json({ success: false, error: "slotDurationMs must be a positive number" });
    }
    if (!recurrenceRule || typeof recurrenceRule !== "string" || recurrenceRule.trim().length === 0) {
      return res.status(400).json({ success: false, error: "recurrenceRule is required" });
    }

    const product = subscriptionService.createProduct({
      name,
      description,
      professional,
      slotDurationMs,
      recurrenceRule,
      timezone,
      priceCents,
      currency,
      maxSubscribers,
    });

    res.status(201).json({ success: true, data: product });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get("/products", async (req: Request, res: Response) => {
  try {
    const professional = typeof req.query.professional === "string" ? req.query.professional : undefined;
    const products = subscriptionService.listProducts(professional);
    res.json({ success: true, data: products, total: products.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/products/:productId", async (req: Request, res: Response) => {
  try {
    const product = subscriptionService.getProduct(req.params.productId);
    res.json({ success: true, data: product });
  } catch (err: any) {
    if (err instanceof SubscriptionProductNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/products/:productId", async (req: Request, res: Response) => {
  try {
    const product = subscriptionService.deactivateProduct(req.params.productId);
    res.json({ success: true, data: product });
  } catch (err: any) {
    if (err instanceof SubscriptionProductNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Subscription Endpoints ───────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const { productId, subscriberId, slotOffsetMs } = req.body;

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ success: false, error: "productId is required" });
    }
    if (!subscriberId || typeof subscriberId !== "string") {
      return res.status(400).json({ success: false, error: "subscriberId is required" });
    }

    const sub = subscriptionService.subscribe({ productId, subscriberId, slotOffsetMs });
    res.status(201).json({ success: true, data: sub });
  } catch (err: any) {
    if (err instanceof SubscriptionProductNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof DuplicateSubscriptionError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    if (err instanceof SubscriptionCapacityExceededError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get("/:subscriptionId", async (req: Request, res: Response) => {
  try {
    const sub = subscriptionService.getSubscription(req.params.subscriptionId);
    res.json({ success: true, data: sub });
  } catch (err: any) {
    if (err instanceof SubscriptionNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const productId = typeof req.query.productId === "string" ? req.query.productId : undefined;
    const subs = subscriptionService.listSubscriptions(productId);
    res.json({ success: true, data: subs, total: subs.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:subscriptionId/pause", async (req: Request, res: Response) => {
  try {
    const sub = subscriptionService.pauseSubscription(req.params.subscriptionId);
    res.json({ success: true, data: sub });
  } catch (err: any) {
    if (err instanceof SubscriptionNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof InvalidSubscriptionStateError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:subscriptionId/resume", async (req: Request, res: Response) => {
  try {
    const sub = subscriptionService.resumeSubscription(req.params.subscriptionId);
    res.json({ success: true, data: sub });
  } catch (err: any) {
    if (err instanceof SubscriptionNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof InvalidSubscriptionStateError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:subscriptionId/cancel", async (req: Request, res: Response) => {
  try {
    const sub = subscriptionService.cancelSubscription(req.params.subscriptionId);
    res.json({ success: true, data: sub });
  } catch (err: any) {
    if (err instanceof SubscriptionNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof InvalidSubscriptionStateError) {
      return res.status(409).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
