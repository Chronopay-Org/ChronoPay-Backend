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
} from "../services/subscriptionService.js";
import {
  InMemorySubscriptionProductRepository,
} from "../modules/subscriptions/subscription-product-repository.js";
import {
  InMemorySubscriptionRepository,
  type SubscriptionRecord,
} from "../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

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

// Every subscription endpoint requires a verified JWT (issue #1311). The
// middleware rejects anonymous and unusable tokens with 401 before any route
// handler runs; ownership/role rules are enforced inside each handler.
router.use(authenticateToken);

/**
 * Identity of the authenticated caller as verified from the JWT.
 * `id` falls back to `sub` (mirrors `getUserId` in middleware/auth.ts);
 * it is "" when the token carries no usable subject.
 */
function readCaller(req: Request): { id: string; role: string } {
  const payload = req.user as
    | { sub?: unknown; id?: unknown; role?: unknown }
    | undefined;
  const rawId = payload?.sub ?? payload?.id;
  const id = typeof rawId === "string" ? rawId.trim() : "";
  const rawRole = payload?.role;
  const role = typeof rawRole === "string" ? rawRole.trim().toLowerCase() : "";
  return { id, role };
}

function denyAccess(res: Response): void {
  res.status(403).json({ success: false, error: "Access denied" });
}

/**
 * Who may read or mutate a subscription: the subscriber, the professional
 * who owns the subscribed product, or an admin. A missing product (should
 * not happen for persisted subscriptions) leaves only subscriber/admin.
 */
function canManageSubscription(req: Request, sub: SubscriptionRecord): boolean {
  const { id, role } = readCaller(req);
  if (role === "admin") return true;
  if (!id) return false;
  if (sub.subscriberId === id) return true;
  try {
    const product = subscriptionService.getProduct(sub.productId);
    return product.professional === id;
  } catch {
    return false;
  }
}

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

    // Products can only be created by/for a professional acting for
    // themselves — or by an admin on any professional's behalf.
    const { id: callerId, role } = readCaller(req);
    if (role !== "admin") {
      if (role !== "professional" || callerId !== professional) {
        return denyAccess(res);
      }
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
    // Load first so ownership can be checked against the product's current
    // professional before deactivating it (missing product still → 404).
    const existing = subscriptionService.getProduct(req.params.productId);

    const { id: callerId, role } = readCaller(req);
    if (role !== "admin" && !(role === "professional" && callerId === existing.professional)) {
      return denyAccess(res);
    }

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
    const { productId, slotOffsetMs } = req.body;

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ success: false, error: "productId is required" });
    }

    // The subscriber is always the authenticated caller (issue #1311); a
    // subscriberId in the body may match the caller but can never act for
    // someone else — differing values are rejected outright.
    const { id: callerId } = readCaller(req);
    if (!callerId) {
      return denyAccess(res);
    }
    if (req.body.subscriberId !== undefined && req.body.subscriberId !== callerId) {
      return res.status(403).json({
        success: false,
        error: "subscriberId must match the authenticated caller",
      });
    }

    const sub = subscriptionService.subscribe({ productId, subscriberId: callerId, slotOffsetMs });
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
    if (!canManageSubscription(req, sub)) {
      return denyAccess(res);
    }
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
    let subs = subscriptionService.listSubscriptions(productId);

    // Non-admin callers only see subscriptions they belong to (as the
    // subscriber) or that belong to their own products; admins see all.
    const { id: callerId, role } = readCaller(req);
    if (role !== "admin") {
      const professionalByProduct = new Map(
        subscriptionService.listProducts().map((p) => [p.id, p.professional]),
      );
      subs = subs.filter(
        (s) => s.subscriberId === callerId || professionalByProduct.get(s.productId) === callerId,
      );
    }

    res.json({ success: true, data: subs, total: subs.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:subscriptionId/pause", async (req: Request, res: Response) => {
  try {
    const sub = subscriptionService.getSubscription(req.params.subscriptionId);
    if (!canManageSubscription(req, sub)) {
      return denyAccess(res);
    }
    const paused = subscriptionService.pauseSubscription(req.params.subscriptionId);
    res.json({ success: true, data: paused });
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
    const sub = subscriptionService.getSubscription(req.params.subscriptionId);
    if (!canManageSubscription(req, sub)) {
      return denyAccess(res);
    }
    const resumed = subscriptionService.resumeSubscription(req.params.subscriptionId);
    res.json({ success: true, data: resumed });
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
    const sub = subscriptionService.getSubscription(req.params.subscriptionId);
    if (!canManageSubscription(req, sub)) {
      return denyAccess(res);
    }
    const cancelled = subscriptionService.cancelSubscription(req.params.subscriptionId);
    res.json({ success: true, data: cancelled });
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
