/**
 * Typed failures for the MFA flow. Thrown by mfaService / requireFreshMfa and
 * mapped to stable HTTP responses by the route handlers, mirroring the flat
 * `{ success: false, error }` envelope used across this API.
 */

export interface MfaErrorShape {
  readonly statusCode: number;
  readonly errorCode: string;
}

export class MfaConfigurationError extends Error implements MfaErrorShape {
  readonly statusCode = 500;
  readonly errorCode = "MFA_CONFIGURATION_ERROR";

  constructor(detail: string) {
    super(`MFA is not configured: ${detail}`);
    this.name = "MfaConfigurationError";
  }
}

export class MfaNotEnrolledError extends Error implements MfaErrorShape {
  readonly statusCode = 404;
  readonly errorCode = "MFA_NOT_ENROLLED";

  constructor() {
    super("MFA is not enabled for this account");
    this.name = "MfaNotEnrolledError";
  }
}

export class MfaAlreadyEnrolledError extends Error implements MfaErrorShape {
  readonly statusCode = 409;
  readonly errorCode = "MFA_ALREADY_ENROLLED";

  constructor() {
    super("MFA is already enabled for this account");
    this.name = "MfaAlreadyEnrolledError";
  }
}

export class MfaInvalidCodeError extends Error implements MfaErrorShape {
  readonly statusCode = 401;
  readonly errorCode = "MFA_INVALID_CODE";

  constructor() {
    super("Invalid or expired MFA code");
    this.name = "MfaInvalidCodeError";
  }
}

export class MfaReplayDetectedError extends Error implements MfaErrorShape {
  readonly statusCode = 409;
  readonly errorCode = "MFA_REPLAY_DETECTED";

  constructor() {
    super("This MFA code was already used");
    this.name = "MfaReplayDetectedError";
  }
}

export class MfaChallengeExpiredError extends Error implements MfaErrorShape {
  readonly statusCode = 401;
  readonly errorCode = "MFA_CHALLENGE_EXPIRED";

  constructor() {
    super("MFA challenge has expired; please verify again");
    this.name = "MfaChallengeExpiredError";
  }
}

export class MfaChallengeInvalidError extends Error implements MfaErrorShape {
  readonly statusCode = 401;
  readonly errorCode = "MFA_CHALLENGE_INVALID";

  constructor() {
    super("Invalid MFA challenge");
    this.name = "MfaChallengeInvalidError";
  }
}

export function isMfaError(error: unknown): error is Error & MfaErrorShape {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as MfaErrorShape).statusCode === "number" &&
    "errorCode" in error
  );
}