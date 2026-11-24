import { afterEach, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import router, { subscriptionService as routeService } from "../../routes/subscriptions.js";
import {
  subscriptionService,
  subscriptionContainer,
  createSubscriptionContainer,
} from "../subscriptionContainer.js";
import { createSubscriptionSlotGenerator } from "../../scheduler/subscriptionSlotGenerator.js";
import { InMemorySubscriptionProductRepository } from "../../modules/subscriptions/subscription-product-repository.js";
import { InMemorySubscriptionRepository } from "../../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository } from "../../modules/slots/slot-repository.js";

afterEach(() => {
  jest.restoreAllMocks();
});

it("generates for an HTTP-created subscription and exposes the updated state through that router", async () => {
  const app = express();
  app.use(express.json());
  app.use("/subscriptions", router);
  const product = await request(app)
    .post("/subscriptions/products")
    .send({
      name: "HTTP product",
      professional: "composition-professional",
      slotDurationMs: 3600000,
      recurrenceRule: "FREQ=DAILY",
    });
  expect(product.status).toBe(201);
  const response = await request(app)
    .post("/subscriptions")
    .send({ productId: product.body.data.id, subscriberId: "composition-subscriber" });
  expect(response.status).toBe(201);
  const sub = response.body.data;
  jest.spyOn(Date, "now").mockReturnValue(sub.nextSlotStartMs);
  expect(routeService).toBe(subscriptionService);
  expect(subscriptionContainer.service).toBe(routeService);
  const generator = createSubscriptionSlotGenerator(subscriptionService);
  const first = generator.runOnce();
  expect(first.minted).toHaveLength(1);
  expect(first.minted[0]).toMatchObject({
    subscriptionId: sub.id,
    professional: "composition-professional",
    startTime: sub.nextSlotStartMs,
  });
  const fetched = await request(app).get(`/subscriptions/${sub.id}`);
  expect(fetched.body.data.slotsMinted).toBe(1);
  expect(fetched.body.data.nextSlotStartMs).toBe(first.minted[0].nextSlotStartMs);
  expect(routeService.getSubscription(sub.id).slotsMinted).toBe(1);
  expect(generator.runOnce().minted).toEqual([]);
});

it("supports repository injection without sharing state between isolated containers", () => {
  const products = new InMemorySubscriptionProductRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const slots = new InMemorySlotRepository([]);
  const container = createSubscriptionContainer({ products, subscriptions, slots });
  const other = createSubscriptionContainer();
  expect(container.products).toBe(products);
  expect(container.subscriptions).toBe(subscriptions);
  expect(container.slots).toBe(slots);
  const product = container.service.createProduct({
    name: "Isolated",
    professional: "isolated-professional",
    slotDurationMs: 3600000,
    recurrenceRule: "FREQ=DAILY",
  });
  expect(container.products.findById(product.id)?.name).toBe("Isolated");
  expect(other.service.listProducts()).toEqual([]);
  const sub = container.service.subscribe({
    productId: product.id,
    subscriberId: "isolated-subscriber",
  });
  jest.spyOn(Date, "now").mockReturnValue(sub.nextSlotStartMs);
  expect(createSubscriptionSlotGenerator(other.service).runOnce().minted).toEqual([]);
  expect(createSubscriptionSlotGenerator(container.service).runOnce().minted).toHaveLength(1);
});
