import {
  MfaConfigurationError,
  MfaNotEnrolledError,
  MfaAlreadyEnrolledError,
  MfaInvalidCodeError,
  MfaReplayDetectedError,
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  isMfaError,
} from "../mfaErrors";

describe("MfaErrors", () => {
  describe("MfaConfigurationError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaConfigurationError("test detail");
      expect(error.name).toBe("MfaConfigurationError");
      expect(error.message).toBe("MFA is not configured: test detail");
      expect(error.statusCode).toBe(500);
      expect(error.errorCode).toBe("MFA_CONFIGURATION_ERROR");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaNotEnrolledError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaNotEnrolledError();
      expect(error.name).toBe("MfaNotEnrolledError");
      expect(error.message).toBe("MFA is not enabled for this account");
      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe("MFA_NOT_ENROLLED");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaAlreadyEnrolledError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaAlreadyEnrolledError();
      expect(error.name).toBe("MfaAlreadyEnrolledError");
      expect(error.message).toBe("MFA is already enabled for this account");
      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe("MFA_ALREADY_ENROLLED");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaInvalidCodeError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaInvalidCodeError();
      expect(error.name).toBe("MfaInvalidCodeError");
      expect(error.message).toBe("Invalid or expired MFA code");
      expect(error.statusCode).toBe(401);
      expect(error.errorCode).toBe("MFA_INVALID_CODE");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaReplayDetectedError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaReplayDetectedError();
      expect(error.name).toBe("MfaReplayDetectedError");
      expect(error.message).toBe("This MFA code was already used");
      expect(error.statusCode).toBe(409);
      expect(error.errorCode).toBe("MFA_REPLAY_DETECTED");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaChallengeExpiredError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaChallengeExpiredError();
      expect(error.name).toBe("MfaChallengeExpiredError");
      expect(error.message).toBe("MFA challenge has expired; please verify again");
      expect(error.statusCode).toBe(401);
      expect(error.errorCode).toBe("MFA_CHALLENGE_EXPIRED");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("MfaChallengeInvalidError", () => {
    it("should create an error with the correct properties", () => {
      const error = new MfaChallengeInvalidError();
      expect(error.name).toBe("MfaChallengeInvalidError");
      expect(error.message).toBe("Invalid MFA challenge");
      expect(error.statusCode).toBe(401);
      expect(error.errorCode).toBe("MFA_CHALLENGE_INVALID");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("isMfaError", () => {
    it("should return true for valid MfaError instances", () => {
      const errors = [
        new MfaConfigurationError("test"),
        new MfaNotEnrolledError(),
        new MfaAlreadyEnrolledError(),
        new MfaInvalidCodeError(),
        new MfaReplayDetectedError(),
        new MfaChallengeExpiredError(),
        new MfaChallengeInvalidError(),
      ];

      errors.forEach((error) => {
        expect(isMfaError(error)).toBe(true);
      });
    });

    it("should return false for generic Error instances", () => {
      const error = new Error("Generic error");
      expect(isMfaError(error)).toBe(false);
    });

    it("should return false for objects that match shape but are not Error instances", () => {
      const fauxError = {
        statusCode: 404,
        errorCode: "MFA_NOT_ENROLLED",
      };
      expect(isMfaError(fauxError)).toBe(false);
    });
      
    it("should return false for error-like objects missing statusCode", () => {
      class MissingStatusCode extends Error {
        errorCode = "MFA_NOT_ENROLLED";
      }
      expect(isMfaError(new MissingStatusCode())).toBe(false);
    });
    
    it("should return false for error-like objects where statusCode is not a number", () => {
      class InvalidStatusCode extends Error {
        statusCode = "404";
        errorCode = "MFA_NOT_ENROLLED";
      }
      expect(isMfaError(new InvalidStatusCode())).toBe(false);
    });

    it("should return false for error-like objects missing errorCode", () => {
      class MissingErrorCode extends Error {
        statusCode = 404;
      }
      expect(isMfaError(new MissingErrorCode())).toBe(false);
    });

    it("should return false for primitive values", () => {
      expect(isMfaError(null)).toBe(false);
      expect(isMfaError(undefined)).toBe(false);
      expect(isMfaError("error")).toBe(false);
      expect(isMfaError(123)).toBe(false);
      expect(isMfaError(true)).toBe(false);
    });
  });
});
