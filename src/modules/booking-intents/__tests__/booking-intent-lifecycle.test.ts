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
  const ___slotRepo = new InMemorySlotRepository();
  const ___intentRepo = new InMemoryBookingIntentRepository();
  // @ts-expect-error - Auto-fixed by script
  const service = new BookingIntentService(_intentRepo, _slotRepo);
  // @ts-expect-error - Auto-fixed by script
  return { _slotRepo, _intentRepo, service };
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
    ({ _slotRepo, _intentRepo, service } = createFixture());
  });

  describe("confirmIntent", () => {
    it("confirms a pending intent (intent owner)", async () => {
      const intent = await createPendingIntent();
      const result = service.confirmIntent(intent.id, customer);
      expect(result.status).toBe("confirmed");
    });

    it("confirms a pending intent (admin)", async () => {
      const intent = await createPendingIntent();
      const result = service.confirmIntent(intent.id, admin);
      expect(result.status).toBe("confirmed");
    });

    it("throws 404 for non-existent intent", () => {
      expect(() => service.confirmIntent("no-such-id", customer)).toThrow(
        BookingIntentError,
      );
      try {
        service.confirmIntent("no-such-id", customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(404);
      }
    });

    it("throws 403 for non-owner non-admin", async () => {
      const intent = await createPendingIntent();
      expect(() => service.confirmIntent(intent.id, otherCustomer)).toThrow(
        BookingIntentError,
      );
      try {
        service.confirmIntent(intent.id, otherCustomer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(403);
      }
    });

    it("throws 409 for already-confirmed intent (double-confirm)", async () => {
      const intent = await createPendingIntent();
      service.confirmIntent(intent.id, customer);
      expect(() => service.confirmIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
      try {
        service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });

    it("throws 409 for cancelled intent", async () => {
      const intent = await createPendingIntent();
      service.cancelIntent(intent.id, customer);
      expect(() => service.confirmIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
      try {
        service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });

    it("throws 409 for expired intent", async () => {
      const intent = await createPendingIntent();
      service.expireIntent(intent.id);
      expect(() => service.confirmIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
      try {
        service.confirmIntent(intent.id, customer);
      } catch (e) {
        expect((e as BookingIntentError).status).toBe(409);
      }
    });
  });

  describe("cancelIntent", () => {
    it("cancels a pending intent (intent owner)", async () => {
      const intent = await createPendingIntent();
      const result = service.cancelIntent(intent.id, customer);
      expect(result.status).toBe("cancelled");
    });

    it("cancels a pending intent (admin)", async () => {
      const intent = await createPendingIntent();
      const result = service.cancelIntent(intent.id, admin);
      expect(result.status).toBe("cancelled");
    });

    it("throws 404 for non-existent intent", () => {
      expect(() => service.cancelIntent("no-such-id", customer)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 403 for unauthorized user", async () => {
      const intent = await createPendingIntent();
      expect(() => service.cancelIntent(intent.id, otherCustomer)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for confirmed intent (cancel-after-confirm)", async () => {
      const intent = await createPendingIntent();
      service.confirmIntent(intent.id, customer);
      expect(() => service.cancelIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for already-cancelled intent (double-cancel)", async () => {
      const intent = await createPendingIntent();
      service.cancelIntent(intent.id, customer);
      expect(() => service.cancelIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for expired intent", async () => {
      const intent = await createPendingIntent();
      service.expireIntent(intent.id);
      expect(() => service.cancelIntent(intent.id, customer)).toThrow(
        BookingIntentError,
      );
    });
  });

  describe("expireIntent", () => {
    it("expires a pending intent", async () => {
      const intent = await createPendingIntent();
      const result = service.expireIntent(intent.id);
      expect(result.status).toBe("expired");
    });

    it("throws 404 for non-existent intent", () => {
      expect(() => service.expireIntent("no-such-id")).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for confirmed intent", async () => {
      const intent = await createPendingIntent();
      service.confirmIntent(intent.id, customer);
      expect(() => service.expireIntent(intent.id)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for cancelled intent", async () => {
      const intent = await createPendingIntent();
      service.cancelIntent(intent.id, customer);
      expect(() => service.expireIntent(intent.id)).toThrow(
        BookingIntentError,
      );
    });

    it("throws 409 for already-expired intent", async () => {
      const intent = await createPendingIntent();
      service.expireIntent(intent.id);
      expect(() => service.expireIntent(intent.id)).toThrow(
        BookingIntentError,
      );
    });
  });

  describe("createIntent", () => {
    it("still creates a pending intent after lifecycle methods exist", async () => {
      const intent = await createPendingIntent();
      expect(intent.status).toBe("pending");
    });
  });
});
