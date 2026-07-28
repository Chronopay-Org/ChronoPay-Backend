import { describe, it, expect } from "@jest/globals";
import {
  buildSlackReport,
  budgetBar,
  budgetStatus,
  SloData,
} from "../slo-weekly-report.js";

describe("budgetBar", () => {
  it("renders all filled for 1.0", () => {
    expect(budgetBar(1.0)).toBe("██████████");
  });

  it("renders all empty for 0.0", () => {
    expect(budgetBar(0.0)).toBe("░░░░░░░░░░");
  });

  it("renders half filled for 0.5", () => {
    expect(budgetBar(0.5)).toBe("█████░░░░░");
  });

  it("clamps to 10 segments", () => {
    expect(budgetBar(1.5)).toBe("██████████");
    expect(budgetBar(-0.5)).toBe("░░░░░░░░░░");
  });
});

describe("budgetStatus", () => {
  it("returns Exhausted for 0", () => {
    expect(budgetStatus(0)).toContain("Exhausted");
  });

  it("returns Critical below 0.2", () => {
    expect(budgetStatus(0.1)).toContain("Critical");
    expect(budgetStatus(0.19)).toContain("Critical");
  });

  it("returns At Risk between 0.2 and 0.5", () => {
    expect(budgetStatus(0.3)).toContain("At Risk");
    expect(budgetStatus(0.49)).toContain("At Risk");
  });

  it("returns Healthy at or above 0.5", () => {
    expect(budgetStatus(0.5)).toContain("Healthy");
    expect(budgetStatus(0.9)).toContain("Healthy");
  });
});

describe("buildSlackReport", () => {
  it("returns a message with header and leaderboard", () => {
    const slos: SloData[] = [
      { route: "/api/checkout", totalRequests: 1000, badEvents: 5, sloTarget: 0.99, remainingBudget: 0.5 },
      { route: "/api/payments", totalRequests: 500, badEvents: 50, sloTarget: 0.95, remainingBudget: 0.1 },
    ];

    const result = buildSlackReport(slos, "https://grafana.example.com/d/slo");

    expect(result.text).toContain("1 service(s) critically low");
    expect(result.blocks.length).toBeGreaterThan(0);

    // Find the leaderboard section (second section block after header)
    const sectionBlocks = result.blocks.filter((b: any) => b.type === "section" && b.text);
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);
    const leaderboardText: string = sectionBlocks[1].text.text;

    // payments (0.1) should appear before checkout (0.5)
    const paymentsIdx = leaderboardText.indexOf("/api/payments");
    const checkoutIdx = leaderboardText.indexOf("/api/checkout");
    expect(paymentsIdx).toBeGreaterThan(0);
    expect(paymentsIdx).toBeLessThan(checkoutIdx);

    // Should contain dashboard link
    const contextBlock = result.blocks.find((b: any) => b.type === "context");
    expect(contextBlock).toBeDefined();
    const contextText: string = contextBlock.elements[0].text;
    expect(contextText).toContain("grafana.example.com");
  });

  it("returns no-data message when SLO list is empty", () => {
    const result = buildSlackReport([], "https://grafana.example.com/d/slo");
    // The second section block (after header + divider) contains the "no data" message
    const sectionBlocks = result.blocks.filter((b: any) => b.type === "section" && b.text);
    expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);
    expect(sectionBlocks[1].text.text).toContain("No SLO data available");
  });
});
