import { expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";
import { getActiveRequestCount, trackRequests } from "../index.js";
import type { RequestHandler } from "express";

it("tracks a real request before createApp's routes and terminal handlers", async () => {
  let observed = 0;
  const tracker: RequestHandler = (req, res, next) => {
    trackRequests(req, res, () => {
      observed = getActiveRequestCount();
      next();
    });
  };
  const options = { enableDocs: false, requestTracker: tracker };
  const app = createApp(options);
  const response = await request(app).get("/health").set("x-strict-health", "1");
  expect(response.status).toBe(200);
  expect(observed).toBe(1);
  expect(getActiveRequestCount()).toBe(0);
});
