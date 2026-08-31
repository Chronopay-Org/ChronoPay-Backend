import { MfaService } from "../mfaService.js";
import { createFakeMfaRepository, flushMicrotasks } from "../../test-helpers/fakeMfaRepository.js";
import { configService } from "../../config/config.service.js";
import {
  base32Decode,
  generateTotpCode,
  generateTotpSecret,
  totpCounter,
} from "../../utils/totp.js";
import {
  MfaAlreadyEnrolledError,
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  MfaConfigurationError,
  MfaInvalidCodeError,
  MfaNotEnrolledError,
  MfaReplayDetectedError,
} from "../../errors/mfaErrors.js";

const MASTER_KEY = "e".repeat(64);
const CHALLENGE_SECRET = "mfa-challenge-secret-12345";

function makeService() {
  const handle = createFakeMfaRepository();
  const service = new MfaService(() => handle.repo);
  return { service, handle };
}

describe("MfaService.enroll", () => {
  it("creates a pending enrollment and returns secret + otpauth URL", async () => {
    const { service, handle } = makeService();
    const result = await service.enroll("user-1", { masterKey: MASTER_KEY, issuer: "ChronoPay" });

    expect(result.secret).toHaveLength(32);
    expect(base32Decode(result.secret)).toHaveLength(20);
    expect(result.otpauthUrl).toContain(`secret=${result.secret}`);
    expect(result.otpauthUrl).toContain("issuer=ChronoPay");
    expect(result.digits).toBe(6);
    expect(result.period).toBe(30);
    expect(result.alreadyVerified).toBe(false);
    expect(result.algorithm).toBe("SHA1");

    const stored = handle.rows.get("user-1");
    expect(stored?.verified).toBe(false);
    expect(stored?.last_used_counter).toBeNull();
    expect(stored?.secret_ciphertext).toHaveLength(40);
    expect(stored?.kdf_salt).toHaveLength(32);
  });

  it("allows re-enrolling while an enrollment is still pending", async () => {
    const { service, handle } = makeService();
    await service.enroll("user-1", { masterKey: MASTER_KEY });
    const first = handle.rows.get("user-1");
    await service.enroll("user-1", { masterKey: MASTER_KEY });
    expect(handle.rows.get("user-1")?.secret_ciphertext).not.toBe(first?.secret_ciphertext);
  });

  it("rejects enrolling when MFA is already active", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY);

    await expect(service.enroll("user-1", { masterKey: MASTER_KEY })).rejects.toThrow(
      MfaAlreadyEnrolledError,
    );
  });

  it("throws MfaConfigurationError when the master key is not provisioned", async () => {
    const { service } = makeService();
    delete process.env.MFA_ENCRYPTION_KEY;
    configService.refresh();
    await flushMicrotasks();

    await expect(service.enroll("user-1", {})).rejects.toThrow(MfaConfigurationError);
  });
});

describe("MfaService.verifyCode", () => {
  const nowMs = 1_700_000_000_000;
  const period = 30;

  it("accepts a valid code, advances the counter, activates a pending enrollment, returns a token", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY, { verified: false });
    expect(handle.rows.get("user-1")?.verified).toBe(false);

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(rawSecret, step);

    const result = await service.verifyCode("user-1", code, {
      masterKey: MASTER_KEY,
      challengeSecret: CHALLENGE_SECRET,
      issuer: "ChronoPay",
      nowMs,
    });

    expect(handle.rows.get("user-1")?.verified).toBe(true);
    expect(handle.rows.get("user-1")?.last_used_counter).toBe(step);
    expect(result.alreadyVerified).toBe(false);
    expect(result.mfaToken).toBeTruthy();
    expect(result.expiresInSec).toBeGreaterThan(0);
    expect(result.freshUntilSec).toBe(nowMs / 1000 + 900);
  });

  it("returns alreadyVerified=true when the enrollment was already active", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    const seeded = await handle.seedVerified("user-1", rawSecret, MASTER_KEY);
    seeded.verified = true;

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(rawSecret, step);
    const result = await service.verifyCode("user-1", code, {
      masterKey: MASTER_KEY,
      challengeSecret: CHALLENGE_SECRET,
      nowMs,
    });
    expect(result.alreadyVerified).toBe(true);
  });

  it("throws MfaInvalidCodeError for a wrong code", async () => {
    const { service, handle } = makeService();
    await handle.seedVerified("user-1", generateTotpSecret(), MASTER_KEY);

    await expect(
      service.verifyCode("user-1", "000000", {
        masterKey: MASTER_KEY,
        challengeSecret: CHALLENGE_SECRET,
        nowMs,
      }),
    ).rejects.toThrow(MfaInvalidCodeError);
  });

  it("throws MfaNotEnrolledError when the user has no enrollment", async () => {
    const { service } = makeService();
    await expect(
      service.verifyCode("nobody", "123456", {
        masterKey: MASTER_KEY,
        challengeSecret: CHALLENGE_SECRET,
        nowMs,
      }),
    ).rejects.toThrow(MfaNotEnrolledError);
  });

  it("rejects replaying a code from a previously used counter step", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY);

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(rawSecret, step);

    await service.verifyCode("user-1", code, {
      masterKey: MASTER_KEY,
      challengeSecret: CHALLENGE_SECRET,
      nowMs: nowMs + 1000,
    });

    // Same step, same code — must be rejected as a replay even though it is
    // still inside the window.
    await expect(
      service.verifyCode("user-1", code, {
        masterKey: MASTER_KEY,
        challengeSecret: CHALLENGE_SECRET,
        nowMs: nowMs + 2000,
      }),
    ).rejects.toThrow(MfaReplayDetectedError);
  });

  it("only lets one of two concurrent same-step requests win", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY);

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(rawSecret, step);
    const opts = {
      masterKey: MASTER_KEY,
      challengeSecret: CHALLENGE_SECRET,
      nowMs,
    };

    const [first, second] = await Promise.allSettled([
      service.verifyCode("user-1", code, opts),
      service.verifyCode("user-1", code, opts),
    ]);

    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(handle.rows.get("user-1")?.last_used_counter).toBe(step);
  });

  it("accepts a code from the previous step (clock skew window)", async () => {
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY);

    const step = totpCounter(nowMs, period);
    const previous = generateTotpCode(rawSecret, step - 1);
    const result = await service.verifyCode("user-1", previous, {
      masterKey: MASTER_KEY,
      challengeSecret: CHALLENGE_SECRET,
      nowMs,
    });
    expect(result.mfaToken).toBeTruthy();
    expect(handle.rows.get("user-1")?.last_used_counter).toBe(step - 1);
  });

  it("fails closed when the master key cannot decrypt the stored secret", async () => {
    const { service, handle } = makeService();
    await handle.seedVerified("user-1", generateTotpSecret(), "f".repeat(64));

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(generateTotpSecret(), step);

    await expect(
      service.verifyCode("user-1", code, {
        masterKey: "e".repeat(64),
        challengeSecret: CHALLENGE_SECRET,
        nowMs,
      }),
    ).rejects.toThrow();
  });
});

describe("MfaService challenge tokens", () => {
  const nowMs = 1_700_000_000_000;
  const base = {
    challengeSecret: CHALLENGE_SECRET,
    issuer: "ChronoPay",
    audience: "chronopay-api",
    nowMs,
  };

  it("round-trips an issued challenge", async () => {
    const { service } = makeService();
    const { mfaToken } = await service.issueChallenge("user-1", { ...base, challengeTtlSec: 300 });

    const result = await service.verifyChallenge(mfaToken, { ...base, expectedUserId: "user-1" });
    expect(result.userId).toBe("user-1");
    expect(result.mfaAtSec).toBe(Math.floor(nowMs / 1000));
  });

  it("rejects a challenge signed with the wrong secret", async () => {
    const { service } = makeService();
    const { mfaToken } = await service.issueChallenge("user-1", { ...base, challengeSecret: "other" });

    await expect(service.verifyChallenge(mfaToken, { ...base })).rejects.toThrow(MfaChallengeInvalidError);
  });

  it("rejects a token signed with the main JWT secret", async () => {
    const { service } = makeService();
    const { signJwt } = await import("../../utils/jwt.js");
    const forged = await signJwt({ sub: "user-1", iat: Math.floor(nowMs / 1000), mfa_at: Math.floor(nowMs / 1000) }, "jwt-secret-not-mfa-0000", {
      expiresInSec: 300,
      issuer: "ChronoPay",
      audience: "chronopay-api",
    });

    await expect(service.verifyChallenge(forged, { ...base })).rejects.toThrow(MfaChallengeInvalidError);
  });

  it("rejects a challenge whose subject does not match the requester", async () => {
    const { service } = makeService();
    const { mfaToken } = await service.issueChallenge("user-1", { ...base });

    await expect(service.verifyChallenge(mfaToken, { ...base, expectedUserId: "user-2" })).rejects.toThrow(
      MfaChallengeInvalidError,
    );
  });

  it("rejects a challenge that has outlived the freshness window", async () => {
    const { service } = makeService();
    const stale = await service.issueChallenge("user-1", { ...base, nowMs: nowMs - 20 * 60 * 1000 });

    await expect(service.verifyChallenge(stale.mfaToken, { ...base, freshnessMs: 15 * 60 * 1000 })).rejects.toThrow(
      MfaChallengeExpiredError,
    );
  });

  it("rejects a malformed token", async () => {
    const { service } = makeService();
    await expect(service.verifyChallenge("not.a.token", { ...base })).rejects.toThrow(MfaChallengeInvalidError);
  });

  it("rejects a challenge missing the mfa_at claim", async () => {
    const { service } = makeService();
    const { signJwt } = await import("../../utils/jwt.js");
    const noClaim = await signJwt({ sub: "user-1", iat: Math.floor(nowMs / 1000) }, CHALLENGE_SECRET, {
      expiresInSec: 300,
      issuer: "ChronoPay",
      audience: "chronopay-api",
    });

    await expect(service.verifyChallenge(noClaim, { ...base })).rejects.toThrow(MfaChallengeInvalidError);
  });

  it("rejects a challenge without a subject", async () => {
    const { service } = makeService();
    const { signJwt } = await import("../../utils/jwt.js");
    const noSubject = await signJwt(
      { iat: Math.floor(nowMs / 1000), mfa_at: Math.floor(nowMs / 1000) },
      CHALLENGE_SECRET,
      { expiresInSec: 300, issuer: "ChronoPay", audience: "chronopay-api" },
    );

    await expect(service.verifyChallenge(noSubject, { ...base })).rejects.toThrow(MfaChallengeInvalidError);
  });
});

describe("MfaService configuration errors", () => {
  it("throws MfaConfigurationError when the master key is not provisioned", async () => {
    const { service } = makeService();
    delete process.env.MFA_ENCRYPTION_KEY;
    configService.refresh();
    await flushMicrotasks();

    await expect(service.enroll("user-1", {})).rejects.toThrow(MfaConfigurationError);
  });

  it("issues and verifies challenges using environment-based defaults when options are omitted", async () => {
    process.env.MFA_CHALLENGE_SECRET = CHALLENGE_SECRET;
    process.env.MFA_ISSUER = "ChronoPay";
    configService.refresh();
    await flushMicrotasks(20);

    const { service } = makeService();
    const { mfaToken: token } = await service.issueChallenge("user-1");
    const result = await service.verifyChallenge(token);
    expect(result.userId).toBe("user-1");

    delete process.env.MFA_CHALLENGE_SECRET;
    delete process.env.MFA_ISSUER;
    configService.refresh();
    await flushMicrotasks(20);
  });

  it("throws MfaConfigurationError when the challenge secret is not provisioned", async () => {
    const nowMs = 1_700_000_000_000;
    const period = 30;
    const { service, handle } = makeService();
    const rawSecret = generateTotpSecret();
    await handle.seedVerified("user-1", rawSecret, MASTER_KEY);

    delete process.env.MFA_CHALLENGE_SECRET;
    configService.refresh();
    await flushMicrotasks();

    const step = totpCounter(nowMs, period);
    const code = generateTotpCode(rawSecret, step);
    await expect(service.verifyCode("user-1", code, { masterKey: MASTER_KEY, nowMs })).rejects.toThrow(
      MfaConfigurationError,
    );
  });
});