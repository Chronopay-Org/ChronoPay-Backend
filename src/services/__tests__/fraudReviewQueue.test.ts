// @ts-nocheck
import { fraudReviewQueue } from "../fraudReviewQueue";
import { logger } from "../../utils/logger";

jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  }
}));

describe("FraudReviewQueue", () => {
  beforeEach(() => {
    fraudReviewQueue._reset();
    jest.clearAllMocks();
  });

  it("should enqueue a review item and set pending status with SLA", () => {
    const item = fraudReviewQueue.enqueue("intent-1", 1, ["disposable_email"]);
    expect(item.id).toMatch(/^hitl-/);
    expect(item.intentId).toBe("intent-1");
    expect(item.score).toBe(1);
    expect(item.status).toBe("pending");
    expect(item.slaBreachAt).toBeGreaterThan(Date.now());
    
    const pending = fraudReviewQueue.getPendingItems();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(item.id);
  });

  it("should allow operator to approve and emit to feature store", () => {
    const item = fraudReviewQueue.enqueue("intent-2", 1, ["shared_ip"]);
    const decided = fraudReviewQueue.decide(item.id, "operator-1", "approved", "looks fine");
    
    expect(decided.status).toBe("approved");
    expect(decided.operatorId).toBe("operator-1");
    expect(decided.decisionNotes).toBe("looks fine");

    const pending = fraudReviewQueue.getPendingItems();
    expect(pending).toHaveLength(0);

    const log = fraudReviewQueue.getFeatureStoreLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      intentId: "intent-2",
      outcome: "approved",
      operatorId: "operator-1",
      notes: "looks fine",
      slaBreached: false,
    });
    expect(logger.info).toHaveBeenCalled();
  });

  it("should track SLA breach correctly for feature store", () => {
    // Spy on Date.now to simulate time passing
    jest.useFakeTimers();
    const item = fraudReviewQueue.enqueue("intent-3", 1, []);
    
    // Fast-forward past the 15 min SLA
    jest.advanceTimersByTime(16 * 60 * 1000);
    
    const _decided = fraudReviewQueue.decide(item.id, "operator-2", "rejected", "too risky");
    
    const log = fraudReviewQueue.getFeatureStoreLog();
    expect(log[0].slaBreached).toBe(true);
    
    jest.useRealTimers();
  });

  it("should throw error if item not found", () => {
    expect(() => fraudReviewQueue.decide("missing-id", "op-1", "approved"))
      .toThrow("Review item not found");
  });

  it("should throw error if item already decided", () => {
    const item = fraudReviewQueue.enqueue("intent-4", 1, []);
    fraudReviewQueue.decide(item.id, "op-1", "approved");
    
    expect(() => fraudReviewQueue.decide(item.id, "op-2", "rejected"))
      .toThrow("Item already decided");
  });

  it("should get item by id", () => {
    const item = fraudReviewQueue.enqueue("intent-5", 1, []);
    const found = fraudReviewQueue.getItem(item.id);
    expect(found).toBeDefined();
    expect(found?.intentId).toBe("intent-5");
  });
});
