import { getFraudReasonCode, getFraudMessage, FraudReasonCode } from "./fraudReasonCodes";

describe("Fraud Reason Codes", () => {
  describe("getFraudReasonCode", () => {
    it("maps velocity_exceeded to RATE_LIMIT_EXCEEDED", () => {
      expect(getFraudReasonCode("velocity_exceeded")).toBe(FraudReasonCode.RATE_LIMIT_EXCEEDED);
    });

    it("maps fingerprint_mismatch to DEVICE_UNRECOGNIZED", () => {
      expect(getFraudReasonCode("fingerprint_mismatch")).toBe(FraudReasonCode.DEVICE_UNRECOGNIZED);
    });

    it("maps disposable_email to INVALID_CONTACT_INFO", () => {
      expect(getFraudReasonCode("disposable_email")).toBe(FraudReasonCode.INVALID_CONTACT_INFO);
    });

    it("maps unknown strings to UNKNOWN_RISK", () => {
      expect(getFraudReasonCode("random_reason")).toBe(FraudReasonCode.UNKNOWN_RISK);
    });
  });

  describe("getFraudMessage", () => {
    it("returns English message by default", () => {
      expect(getFraudMessage(FraudReasonCode.RATE_LIMIT_EXCEEDED)).toBe("You have made too many requests. Please try again later.");
    });

    it("returns Spanish message when requested", () => {
      expect(getFraudMessage(FraudReasonCode.RATE_LIMIT_EXCEEDED, "es")).toBe("Ha realizado demasiadas solicitudes. Por favor, inténtelo de nuevo más tarde.");
    });

    it("returns French message when requested", () => {
      expect(getFraudMessage(FraudReasonCode.RATE_LIMIT_EXCEEDED, "fr")).toBe("Vous avez fait trop de demandes. Veuillez réessayer plus tard.");
    });

    it("falls back to English if locale is not supported", () => {
      expect(getFraudMessage(FraudReasonCode.RATE_LIMIT_EXCEEDED, "de")).toBe("You have made too many requests. Please try again later.");
    });

    it("returns fallback message if code is somehow missing in catalog", () => {
      expect(getFraudMessage("NON_EXISTENT_CODE" as any)).toBe("Unknown risk.");
    });
  });
});
