import {
  BookingIntentService,
  BookingIntentError,
} from "../booking-intent-service.js";
import {
  InMemoryBookingIntentRepository,
} from "../booking-intent-repository.js";
import { InMemorySlotRepository } from "../../slots/slot-repository.js";
import type { AuthContext } from "../../../middleware/auth.js";
import type { VerifiedJwtPayload } from "../../../utils/jwt.js";

const dummyClaims = {} as VerifiedJwtPayload;

const ALICE_SLOT = "slot-11111111-1111-4111-8111-111111111111";
// eslint-disable-next-line unused-imports/no-unused-vars
const BOB_SLOT = "slot-22222222-2222-4222-8222-222222222222";

function createFixture() {
  const slotRepo = new InMemorySlotRepository();
  const intentRepo = new InMemoryBookingIntentRepository();
  const service = new BookingIntentService(intentRepo, slotRepo);
  return { slotRepo, intentRepo, service };
}

const customer: AuthContext = { userId: "cust-1", role: "customer", claims: dummyClaims };
const otherCustomer: AuthContext = { userId: "cust-2", role: "customer", claims: dummyClaims };
const admin: AuthContext = { userId: "admin-1", role: "admin", claims: dummyClaims };
// eslint-disable-next-line unused-imports/no-unused-vars
const professional: AuthContext = { userId: "alice", role: "professional", claims: dummyClaims };

describe("BookingIntentService lifecycle", () => {
  // eslint-disable-next-line unused-imports/no-unused-vars
  let { slotRepo, intentRepo, service } = createFixture();

  function createPendingIntent(actor: AuthContext = customer) {
    return service.createIntent({ slotId: ALICE_SLOT }, actor);
  }

  beforeEach(() => {
    ({ slotRepo, intentRepo, service } = createFixture());
  });

  describe("confirmIntent", () => {
    it("confirms a pending intent (intent owner)", async () => {
      const intent = await createPendingIntent();
      const result = await service.confirmIntent(intent.id, customer);
      expect(result.status).toBe("confirmed");
    });

    it("confirms a pending intent (admin)", async () => {
      const intent = await createPendingIntent();
      const result = await service.confirmIntent(intent.id, admin);
      expect(result.status).toBe("confirmed");
    });

    it("throws 404 for non-existent intent", async () => {
      await expect(service.confirmIntent("no-such-id", customer)).rejects.toThrow(BookingIntentError);
      try {
        await service.confirmIntent("no-such-id", customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(404);
      }
    });

    it("throws 403 for non-owner non-admin", async () => {
      const intent = await createPendingIntent();
      await expect(service.confirmIntent(intent.id, otherCustomer)).rejects.toThrow(BookingIntentError);
      try {
        await service.confirmIntent(intent.id, otherCustomer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(403);
      }
    });

    it("throws 409 for already-confirmed intent (double-confirm)", async () => {
      const intent = await createPendingIntent();
      await service.confirmIntent(intent.id, customer);
      await expect(service.confirmIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
      try {
        await service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });

    it("throws 409 for cancelled intent", async () => {
      const intent = await createPendingIntent();
      await service.cancelIntent(intent.id, customer);
      await expect(service.confirmIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
      try {
        await service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });

    it("throws 409 for expired intent", async () => {
      const intent = await createPendingIntent();
      await service.expireIntent(intent.id);
      await expect(service.confirmIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
      try {
        await service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });
  });

  describe("cancelIntent", () => {
    it("cancels a pending intent (intent owner)", async () => {
      const intent = await createPendingIntent();
      const result = await service.cancelIntent(intent.id, customer);
      expect(result.status).toBe("cancelled");
    });

    it("cancels a pending intent (admin)", async () => {
      const intent = await createPendingIntent();
      const result = await service.cancelIntent(intent.id, admin);
      expect(result.status).toBe("cancelled");
    });

    it("throws 404 for non-existent intent", async () => {
      await expect(service.cancelIntent("no-such-id", customer)).rejects.toThrow(BookingIntentError);
    });

    it("throws 403 for unauthorized user", async () => {
      const intent = await createPendingIntent();
      await expect(service.cancelIntent(intent.id, otherCustomer)).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for confirmed intent (cancel-after-confirm)", async () => {
      const intent = await createPendingIntent();
      await service.confirmIntent(intent.id, customer);
      await expect(service.cancelIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for already-cancelled intent (double-cancel)", async () => {
      const intent = await createPendingIntent();
      await service.cancelIntent(intent.id, customer);
      await expect(service.cancelIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for expired intent", async () => {
      const intent = await createPendingIntent();
      await service.expireIntent(intent.id);
      await expect(service.cancelIntent(intent.id, customer)).rejects.toThrow(BookingIntentError);
    });
  });

  describe("expireIntent", () => {
    it("expires a pending intent", async () => {
      const intent = await createPendingIntent();
      const result = await service.expireIntent(intent.id);
      expect(result.status).toBe("expired");
    });

    it("throws 404 for non-existent intent", async () => {
      await expect(service.expireIntent("no-such-id")).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for confirmed intent", async () => {
      const intent = await createPendingIntent();
      await service.confirmIntent(intent.id, customer);
      await expect(service.expireIntent(intent.id)).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for cancelled intent", async () => {
      const intent = await createPendingIntent();
      await service.cancelIntent(intent.id, customer);
      await expect(service.expireIntent(intent.id)).rejects.toThrow(BookingIntentError);
    });

    it("throws 409 for already-expired intent", async () => {
      const intent = await createPendingIntent();
      await service.expireIntent(intent.id);
      await expect(service.expireIntent(intent.id)).rejects.toThrow(BookingIntentError);
    });
  });

  describe("createIntent", () => {
    it("still creates a pending intent after lifecycle methods exist", async () => {
      const intent = await createPendingIntent();
      expect(intent.status).toBe("pending");
    });
  });
});
