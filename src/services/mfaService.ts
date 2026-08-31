import { defaultAuditLogger } from "./auditLogger.js";
import { configService } from "../config/config.service.js";
import {
  verifyTotpCode,
  generateTotpSecret,
  base32Encode,
  buildOtpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "../utils/totp.js";
import { encryptTotpSecret, decryptTotpSecret } from "./mfaCrypto.js";
import {
  getMfaRepository,
  type MfaRepository,
} from "../repositories/mfaRepository.js";
import { signJwt, verifyJwtWithKey } from "../utils/jwt.js";
import {
  MfaAlreadyEnrolledError,
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  MfaConfigurationError,
  MfaInvalidCodeError,
  MfaNotEnrolledError,
  MfaReplayDetectedError,
} from "../errors/mfaErrors.js";

/**
 * MFA orchestration: enrolment, code verification with replay protection, and
 * short-lived challenge tokens consumed by the `requireFreshMfa` middleware.
 *
 * All crypto is delegated (totp.ts / mfaCrypto.ts) and all DB access goes
 * through the injected repository, so the service is unit-testable without a
 * database and route tests can exercise the full flow with a fake repository.
 */

export const MFA_DEFAULT_ISSUER = "ChronoPay";

export interface EnrollMfaResult {
  secret: string;
  otpauthUrl: string;
  digits: number;
  period: number;
  algorithm: string;
  alreadyVerified: boolean;
}

export interface VerifyMfaCodeResult {
  mfaToken: string;
  expiresInSec: number;
  freshUntilSec: number;
  alreadyVerified: boolean;
}

export interface MfaServiceOptions {
  masterKey?: string;
  challengeSecret?: string;
  issuer?: string;
  audience?: string;
  windowPeriods?: number;
  challengeTtlSec?: number;
  freshnessMs?: number;
  nowMs?: number;
}

function configuredMasterKey(): string {
  try {
    return configService.getSecret("MFA_ENCRYPTION_KEY");
  } catch {
    throw new MfaConfigurationError("MFA_ENCRYPTION_KEY is not provisioned");
  }
}

function configuredChallengeSecret(): string {
  try {
    return configService.getSecret("MFA_CHALLENGE_SECRET");
  } catch {
    throw new MfaConfigurationError("MFA_CHALLENGE_SECRET is not provisioned");
  }
}

export class MfaService {
  /**
   * Repository is resolved per call (defaulting to the process singleton) so
   * that `setMfaRepositoryForTests` also affects pre-existing instances such
   * as the exported `mfaService` used by the routes.
   */
  constructor(private readonly repositoryFactory: () => MfaRepository = getMfaRepository) {}

  private getRepository(): MfaRepository {
    return this.repositoryFactory();
  }

  private buildConfig(options: MfaServiceOptions = {}) {
    return {
      issuer: options.issuer ?? configService.mfaIssuer ?? MFA_DEFAULT_ISSUER,
      audience: options.audience ?? configService.jwtAudience,
      windowPeriods: options.windowPeriods ?? configService.mfaWindowPeriods,
      challengeTtlSec: options.challengeTtlSec ?? configService.mfaChallengeTtlSec,
      freshnessMs: options.freshnessMs ?? configService.mfaFreshnessMs,
      nowMs: options.nowMs ?? Date.now(),
    };
  }

  private resolveMasterKey(options: MfaServiceOptions): string {
    return options.masterKey ?? configuredMasterKey();
  }

  private resolveChallengeSecret(options: MfaServiceOptions): string {
    return options.challengeSecret ?? configuredChallengeSecret();
  }

  /**
   * Enrols a user for TOTP MFA. Generates a fresh secret, encrypts it at rest
   * (per-user derived key) and returns the base32 secret + otpauth URI so the
   * client can scan a QR / enter the key. A verified (active) enrolment is a
   * hard conflict — a deliberate re-enrolment flow would be required to
   * replace it, and no such flow can stay compatible here by overwriting.
   * A *pending* enrolment is replaced so the user can re-scan after a miss.
   */
  async enroll(userId: string, options: MfaServiceOptions = {}): Promise<EnrollMfaResult> {
    const config = this.buildConfig(options);
    const masterKey = this.resolveMasterKey(options);
    const existing = await this.getRepository().findByUserId(userId);
    if (existing?.verified) {
      throw new MfaAlreadyEnrolledError();
    }

    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, { masterKey });
    await this.getRepository().upsertEnrollment({
      userId,
      secretCiphertext: encrypted.ciphertext.toString("hex"),
      secretIv: encrypted.iv.toString("hex"),
      secretAuthTag: encrypted.authTag.toString("hex"),
      kdfSalt: encrypted.salt.toString("hex"),
      algorithm: "SHA1",
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });

    const secretBase32 = base32Encode(secret);
    const otpauthUrl = buildOtpauthUri(config.issuer, userId, secretBase32, {
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });

    defaultAuditLogger
      .log({
        action: "AUTH_MFA_ENROLLED",
        status: 200,
        metadata: { userId, issuer: config.issuer },
      })
      .catch(() => {});

    return {
      secret: secretBase32,
      otpauthUrl,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      algorithm: "SHA1",
      alreadyVerified: false,
    };
  }

  /**
   * Validates a submitted TOTP code against the stored (decrypted) secret.
   *
   * Replay protection: `verifyTotpCode` returns the matched counter step, and
   * the repository's conditional UPDATE only succeeds when the stored
   * `last_used_counter` is still behind that step. Two simultaneous requests
   * with the same code cannot both win — exactly one is accepted.
   */
  async verifyCode(userId: string, code: string, options: MfaServiceOptions = {}): Promise<VerifyMfaCodeResult> {
    const config = this.buildConfig(options);
    const masterKey = this.resolveMasterKey(options);
    const enrollment = await this.getRepository().findByUserId(userId);
    if (!enrollment) {
      throw new MfaNotEnrolledError();
    }

    const secret = decryptTotpSecret(
      {
        ciphertext: Buffer.from(enrollment.secret_ciphertext, "hex"),
        iv: Buffer.from(enrollment.secret_iv, "hex"),
        authTag: Buffer.from(enrollment.secret_auth_tag, "hex"),
        salt: Buffer.from(enrollment.kdf_salt, "hex"),
      },
      { masterKey },
    );

    const matchedStep = verifyTotpCode(
      secret,
      code,
      { digits: enrollment.digits, period: enrollment.period, window: config.windowPeriods },
      config.nowMs,
    );
    if (matchedStep === null) {
      throw new MfaInvalidCodeError();
    }

    const advance = await this.getRepository().advanceLastUsedCounter(userId, matchedStep);
    if (!advance.advanced) {
      throw new MfaReplayDetectedError();
    }

    if (!enrollment.verified) {
      // First confirmed code activates the enrolment. If two requests race,
      // the second markVerified is a no-op — still a success for that user.
      await this.getRepository().markVerified(userId);
    }

    const challenge = await this.issueChallenge(userId, {
      challengeSecret: this.resolveChallengeSecret(options),
      issuer: config.issuer,
      audience: config.audience,
      challengeTtlSec: config.challengeTtlSec,
      freshnessMs: config.freshnessMs,
      nowMs: config.nowMs,
    });

    defaultAuditLogger
      .log({
        action: "AUTH_MFA_VERIFIED",
        status: 200,
        metadata: { userId, step: matchedStep },
      })
      .catch(() => {});

    return { ...challenge, alreadyVerified: enrollment.verified };
  }

  /**
   * Signs a short-lived MFA challenge token for the verified user. The token
   * is consumed by `requireFreshMfa` on high-risk routes; `iat`/`mfa_at`
   * anchor the freshness window and `exp` bounds the token lifetime.
   */
  async issueChallenge(userId: string, options: MfaServiceOptions = {}): Promise<{
    mfaToken: string;
    expiresInSec: number;
    freshUntilSec: number;
  }> {
    const config = this.buildConfig(options);
    const challengeSecret = options.challengeSecret ?? this.resolveChallengeSecret(options);
    const nowSec = Math.floor(config.nowMs / 1000);

    const challenge = await signJwt(
      {
        sub: userId,
        iat: nowSec,
        mfa_at: nowSec,
      },
      challengeSecret,
      {
        expiresInSec: config.challengeTtlSec,
        issuer: config.issuer,
        audience: config.audience,
      },
    );

    return {
      mfaToken: challenge,
      expiresInSec: config.challengeTtlSec,
      freshUntilSec: nowSec + Math.floor(config.freshnessMs / 1000),
    };
  }

  /**
   * Validates an MFA challenge token. Enforces signature/claims via the shared
   * jose verifier, subject presence, and the freshness window. Throws typed
   * errors the middleware maps to HTTP responses.
   */
  async verifyChallenge(
    token: string,
    options: MfaServiceOptions & { expectedUserId?: string; freshnessMs?: number } = {},
  ): Promise<{ userId: string; mfaAtSec: number; freshUntilSec: number }> {
    const config = this.buildConfig(options);
    const challengeSecret = options.challengeSecret ?? this.resolveChallengeSecret(options);

    let payload;
    try {
      payload = await verifyJwtWithKey(token, challengeSecret, {
        issuer: config.issuer,
        audience: config.audience,
      });
    } catch {
      throw new MfaChallengeInvalidError();
    }

    const subject = typeof payload.sub === "string" ? payload.sub : null;
    if (!subject || subject.length === 0) {
      throw new MfaChallengeInvalidError();
    }
    if (options.expectedUserId && subject !== options.expectedUserId) {
      throw new MfaChallengeInvalidError();
    }

    const mfaAtSec = typeof payload.mfa_at === "number" ? payload.mfa_at : undefined;
    if (mfaAtSec === undefined || mfaAtSec !== payload.iat) {
      throw new MfaChallengeInvalidError();
    }

    const nowSec = Math.floor(config.nowMs / 1000);
    const ageMs = nowSec * 1000 - mfaAtSec * 1000;
    if (ageMs < 0 || ageMs > config.freshnessMs) {
      throw new MfaChallengeExpiredError();
    }

    return {
      userId: subject,
      mfaAtSec,
      freshUntilSec: mfaAtSec + Math.floor(config.freshnessMs / 1000),
    };
  }
}

export const mfaService = new MfaService();