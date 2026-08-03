import { describe, it, expect, jest } from "@jest/globals";
import {
  budgetBar,
  budgetStatus,
  buildSlackReport,
  computeRouteBudget,
  computeWeeklyBudgets,
  defaultWeeklyBudgets,
  fetchWeeklySloData,
  postToSlack,
  runReport,
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

describe("computeWeeklyBudgets", () => {
  it("computes remaining budget from counts and objectives", () => {
    // booking_intent SLO 0.999 → error budget 0.001
    // 1000 requests, 2 errors → error rate 0.002 → consumed 2x budget
    const result = computeRouteBudget("booking_intent", 1000, 2);
    expect(result.consumedFraction).toBeCloseTo(2, 5);
    expect(result.remainingBudget).toBe(0);
    expect(result.sloObjective).toBe(0.999);
  });

  it("returns 100% remaining for routes with no traffic", () => {
    const budgets = computeWeeklyBudgets([
      { route: "checkout", totalRequests: 500, badEvents: 0 },
    ]);
    const checkout = budgets.find((b) => b.route === "checkout");
    expect(checkout?.remainingBudget).toBe(1);
    expect(checkout?.noTraffic).toBe(false);
    expect(budgets.find((b) => b.route === "slots_list")?.noTraffic).toBe(true);
  });

  it("covers all four reported routes", () => {
    const budgets = computeWeeklyBudgets([]);
    expect(budgets).toHaveLength(4);
    expect(budgets.every((b) => b.remainingBudget === 1 && b.noTraffic)).toBe(true);
  });
});

describe("buildSlackReport", () => {
  it("returns a message with header and worst-first leaderboard", () => {
    const slos: SloData[] = [
      {
        route: "checkout",
        totalRequests: 1000,
        badEvents: 5,
        sloObjective: 0.9999,
        observedErrorRate: 0.005,
        consumedFraction: 50,
        remainingBudget: 0.5,
        noTraffic: false,
      },
      {
        route: "slots_list",
        totalRequests: 500,
        badEvents: 50,
        sloObjective: 0.995,
        observedErrorRate: 0.1,
        consumedFraction: 2,
        remainingBudget: 0.1,
        noTraffic: false,
      },
    ];

    const result = buildSlackReport(slos, "https://grafana.example.com/d/slo-burn-rate");

    expect(result.text).toContain("critically low");
    const sectionBlocks = result.blocks.filter(
      (b) => b.type === "section" && (b.text as { text?: string })?.text,
    );
    const leaderboardText = (sectionBlocks[1].text as { text: string }).text;

    expect(leaderboardText.indexOf("slots_list")).toBeLessThan(
      leaderboardText.indexOf("checkout"),
    );
    expect(leaderboardText).toContain("5000.0%` consumed");
    expect(leaderboardText).toContain("`10.0%` remaining");

    const contextBlock = result.blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(
      (contextBlock!.elements as Array<{ text: string }>)[0].text,
    ).toContain("slo-burn-rate");
  });

  it("shows no-traffic markers for an empty week", () => {
    const slos = defaultWeeklyBudgets();
    const result = buildSlackReport(slos, "https://grafana.example.com/d/slo-burn-rate");
    const sectionBlocks = result.blocks.filter(
      (b) => b.type === "section" && (b.text as { text?: string })?.text,
    );
    const leaderboardText = (sectionBlocks[1].text as { text: string }).text;
    expect(leaderboardText).toContain("no traffic");
    expect(leaderboardText).toContain("`100.0%` remaining");
    expect(result.text).toContain("within error budget");
  });

  it("flags exhausted budgets", () => {
    const slos: SloData[] = [
      {
        route: "escrow_listener",
        totalRequests: 100,
        badEvents: 10,
        sloObjective: 0.99,
        observedErrorRate: 0.1,
        consumedFraction: 10,
        remainingBudget: 0,
        noTraffic: false,
      },
    ];
    const result = buildSlackReport(slos, "https://grafana.example.com/d/slo");
    expect(result.text).toContain("exhausted");
    const sectionBlocks = result.blocks.filter(
      (b) => b.type === "section" && (b.text as { text?: string })?.text,
    );
    expect((sectionBlocks[1].text as { text: string }).text).toContain("Exhausted");
  });

  it("returns no-data message when SLO list is empty", () => {
    const result = buildSlackReport([], "https://grafana.example.com/d/slo");
    const sectionBlocks = result.blocks.filter(
      (b) => b.type === "section" && (b.text as { text?: string })?.text,
    );
    expect((sectionBlocks[1].text as { text: string }).text).toContain(
      "No SLO data available",
    );
  });
});

describe("fetchWeeklySloData", () => {
  it("returns default routes when prometheus URL is empty", async () => {
    const slos = await fetchWeeklySloData("");
    expect(slos).toHaveLength(4);
    expect(slos.every((s) => s.remainingBudget === 1 && s.noTraffic)).toBe(true);
  });

  it("falls back to defaults when prometheus returns empty results", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "success", data: { result: [] } }),
    } as Response);

    const slos = await fetchWeeklySloData(
      "http://prometheus:9090",
      7,
      fetchFn as typeof fetch,
    );
    expect(slos).toHaveLength(4);
    expect(slos.every((s) => s.noTraffic)).toBe(true);
  });
});

describe("postToSlack", () => {
  it("throws on non-2xx responses (Slack outage)", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as Response);

    await expect(
      postToSlack(
        "https://hooks.slack.com/test",
        { text: "test", blocks: [] },
        fetchFn as typeof fetch,
      ),
    ).rejects.toThrow("Slack webhook returned 503");
  });

  it("succeeds on 2xx", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as Response);

    await expect(
      postToSlack(
        "https://hooks.slack.com/test",
        { text: "test", blocks: [] },
        fetchFn as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("runReport", () => {
  it("posts a report using mocked fetch", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v1/query")) {
        return {
          ok: true,
          json: async () => ({ status: "success", data: { result: [] } }),
        } as Response;
      }
      if (init?.method === "POST") {
        return { ok: true, status: 200, text: async () => "ok" } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const slos = await runReport({
      prometheusUrl: "",
      slackWebhookUrl: "https://hooks.slack.com/test",
      burnRateDashboardUrl: "https://grafana.example.com/d/slo-burn-rate",
      fetchFn: fetchFn as typeof fetch,
    });

    expect(slos).toHaveLength(4);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("propagates Slack failures", async () => {
    const fetchFn = jest.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "error",
    } as Response);

    await expect(
      runReport({
        prometheusUrl: "",
        slackWebhookUrl: "https://hooks.slack.com/test",
        burnRateDashboardUrl: "https://grafana.example.com/d/slo-burn-rate",
        fetchFn: fetchFn as typeof fetch,
      }),
    ).rejects.toThrow("Slack webhook returned 500");
  });
});
