import request from "supertest";
import app from "../index.js";
import { CheckoutErrorCode } from "../types/checkout.js";

describe("Checkout Strict Validation Integration", () => {
  describe("POST /api/v1/checkout/sessions", () => {
    it("should accept valid decimal string amount", async () => {
      const payload = {
        payment: {
          amount: "10.50",
          currency: "USD",
          paymentMethod: "credit_card",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.session.payment.amount).toBe("10.50");
    });

    it("should reject malformed decimal string amount", async () => {
      const payload = {
        payment: {
          amount: "10.50.10",
          currency: "USD",
          paymentMethod: "credit_card",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CheckoutErrorCode.INVALID_AMOUNT);
    });

    it("should reject amount with too many decimal places", async () => {
      const payload = {
        payment: {
          amount: "1.12345678", // 8 decimals
          currency: "XLM",
          paymentMethod: "crypto",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CheckoutErrorCode.INVALID_AMOUNT);
    });

    it("should accept valid 'native' asset for crypto", async () => {
      const payload = {
        payment: {
          amount: 1000,
          currency: "XLM",
          paymentMethod: "crypto",
          asset: "native",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.session.payment.asset).toBe("native");
    });

    it("should accept valid AssetCode:Issuer for crypto", async () => {
      const payload = {
        payment: {
          amount: 1000,
          currency: "USD",
          paymentMethod: "crypto",
          asset: "USDC:GBX6Y3S2UC2X7Z7Y7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.session.payment.asset).toBe("USDC:GBX6Y3S2UC2X7Z7Y7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X7X");
    });

    it("should reject invalid asset identifier", async () => {
      const payload = {
        payment: {
          amount: 1000,
          currency: "USD",
          paymentMethod: "crypto",
          asset: "INVALID_ASSET",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CheckoutErrorCode.INVALID_ASSET);
    });

    it("should reject crypto payment without valid asset if provided", async () => {
      const payload = {
        payment: {
          amount: 1000,
          currency: "USD",
          paymentMethod: "crypto",
          asset: "USDC", // Missing issuer
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CheckoutErrorCode.INVALID_ASSET);
    });

    it("should reject extremely large amounts", async () => {
      const payload = {
        payment: {
          amount: "100000000000000.1", // Just over 1e14
          currency: "USD",
          paymentMethod: "credit_card",
        },
        customer: {
          customerId: "cust_123",
          email: "test@example.com",
        },
      };

      const res = await request(app)
        .post("/api/v1/checkout/sessions")
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(CheckoutErrorCode.INVALID_AMOUNT);
    });
  });
});
