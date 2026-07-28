# Impersonation Session Recording

## Overview

ChronoPay's impersonation recording system captures and audits every request made by administrators when impersonating user accounts. This provides post-hoc review capabilities and ensures accountability for privileged access.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Impersonation Flow                            │
└─────────────────────────────────────────────────────────────────────┘

    1. Admin requests impersonation token
           ↓
    2. Auth middleware validates token + populates req.impersonation
           ↓
    3. impersonationRecorder middleware intercepts request
           ↓
    4. Request proceeds to route handler
           ↓
    5. Route handler (optionally) calls captureSnapshot(before, after)
           ↓
    6. Response sent to client
           ↓
    7. Middleware records request to ImpersonationSessionStore
           ↓
    8. Audit event emitted (for write operations)
```

## Components

### 1. ImpersonationContext (`req.impersonation`)

Injected by the authentication middleware when an impersonation token is validated:

```typescript
interface ImpersonationContext {
  sessionId: string;          // Unique session identifier
  adminId: string;            // Admin performing impersonation
  targetUserId: string;       // User being impersonated
  captureSnapshot(before, after): void;  // Hook for diff capture
}
```

### 2. ImpersonationRecorder Middleware

**Location:** `src/middleware/impersonationRecorder.ts`

**Responsibility:** Transparent recording of all requests within an impersonation session.

**Key Features:**
- Zero overhead when `req.impersonation` is absent (non-impersonation requests)
- Captures HTTP method, URL, response status, and response body hash (SHA-256)
- Detects write operations (POST/PUT/PATCH/DELETE) and records diffs
- Handles aborted requests and streaming responses
- Never propagates storage errors to HTTP responses

### 3. ImpersonationSessionStore

**Location:** `src/services/impersonationSessionStore.ts`

**Implementations:**
- **InMemoryImpersonationSessionStore**: Volatile, test/dev only
- **FileImpersonationSessionStore**: Production default, JSONL append-only log

**Operations:**
- `openSession(params)` - Create new session
- `appendRequest(sessionId, record)` - Add request to session
- `closeSession(sessionId)` - Mark session as closed
- `expireSession(sessionId)` - Mark session as expired (TTL watchdog)
- `getSession(sessionId)` - Retrieve full session
- `listSessions(options)` - List/filter sessions (summary format)

### 4. Admin Review API

**Location:** `src/routes/admin.ts`

**Endpoints:**

```
GET  /api/v1/admin/impersonation/sessions
GET  /api/v1/admin/impersonation/sessions/:sessionId
POST /api/v1/admin/impersonation/sessions/:sessionId/close
```

## Security Properties

### 1. **No Raw Body Storage**
Response bodies are never stored. Only a SHA-256 hash is retained for integrity verification.

### 2. **Diff-Based Write Capture**
Write operations capture structured field-level diffs (before/after snapshots), not full payloads.

### 3. **Storage Errors Don't Block Requests**
If the session store fails, the HTTP request completes successfully. Storage failures are audited separately.

### 4. **Cryptographically Random Session IDs**
Session identifiers are 128-bit random hex strings, preventing enumeration attacks.

### 5. **Append-Only File Store**
The file-based store uses JSONL (newline-delimited JSON) with atomic appends. Tampering is detectable via audit log correlation.

### 6. **Response Body Truncation**
Bodies larger than 256 KB are truncated to prevent memory exhaustion. The hash is flagged as `<hash>:truncated`.

### 7. **Admin Review is Audited**
Every access to `/admin/impersonation/sessions/:sessionId` emits an audit event recording who reviewed the session.

## Data Model

### ImpersonationSession

```typescript
interface ImpersonationSession {
  sessionId: string;
  adminId: string;
  targetUserId: string;
  reason: string;              // Required justification
  startedAt: string;           // ISO 8601
  endedAt: string | null;      // ISO 8601, null if active
  status: "active" | "closed" | "expired" | "error";
  requests: ImpersonationRequestRecord[];
  writeCount: number;          // Count of requests with diffs
}
```

### ImpersonationRequestRecord

```typescript
interface ImpersonationRequestRecord {
  seq: number;                 // 0-based sequence within session
  timestamp: string;           // ISO 8601
  method: string;              // HTTP method
  url: string;                 // Full path + query string
  responseBodyHash: string;    // SHA-256 hex digest
  responseStatus: number;      // HTTP status code
  beforeSnapshot: Record<string, unknown> | null;  // Pre-write state
  afterSnapshot: Record<string, unknown> | null;   // Post-write state
  diff: ResourceDiffEntry[];   // Field-level changes
  aborted: boolean;            // Client disconnect flag
}
```

### ResourceDiffEntry

```typescript
interface ResourceDiffEntry {
  field: string;     // Dot-notation path (e.g., "user.email")
  before: unknown;   // Value before change
  after: unknown;    // Value after change
}
```

## Usage

### 1. Enable Impersonation Recording (Already Configured)

The middleware is mounted in `src/app.ts` after the auth middleware:

```typescript
// In app.ts
app.use(impersonationRecorder());
```

### 2. Capture Snapshots in Route Handlers

For write operations, call `req.impersonation.captureSnapshot()` before sending the response:

```typescript
app.put("/api/v1/users/:userId", async (req, res) => {
  const userId = req.params.userId;
  
  // Fetch current state
  const before = await userRepository.findById(userId);
  
  // Perform update
  const updated = await userRepository.update(userId, req.body);
  
  // Capture snapshot for audit trail
  if (req.impersonation) {
    req.impersonation.captureSnapshot(before, updated);
  }
  
  res.json({ success: true, user: updated });
});
```

**Best Practices:**
- Only capture snapshots for write operations (POST/PUT/PATCH/DELETE)
- Exclude sensitive fields from snapshots (passwords, tokens) by removing them before capture
- Keep snapshots focused on changed resources, not entire response payloads

### 3. Review Sessions via Admin API

**List sessions:**
```bash
curl -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "https://api.chronopay.com/api/v1/admin/impersonation/sessions?targetUserId=user123&limit=10"
```

**Get full session details:**
```bash
curl -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "https://api.chronopay.com/api/v1/admin/impersonation/sessions/$SESSION_ID"
```

**Manually close a session:**
```bash
curl -X POST \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "https://api.chronopay.com/api/v1/admin/impersonation/sessions/$SESSION_ID/close"
```

## File Store Configuration

### Default Location
```
logs/impersonation-sessions.jsonl
```

### Format
Each line is a complete JSON snapshot of a session (JSONL):

```json
{"sessionId":"abc123","adminId":"admin@example.com","targetUserId":"user456","reason":"Support ticket #789","startedAt":"2026-07-28T08:00:00.000Z","endedAt":null,"status":"active","requests":[],"writeCount":0}
{"sessionId":"abc123","adminId":"admin@example.com","targetUserId":"user456","reason":"Support ticket #789","startedAt":"2026-07-28T08:00:00.000Z","endedAt":null,"status":"active","requests":[{"seq":0,"timestamp":"2026-07-28T08:01:00.000Z","method":"GET","url":"/api/v1/users","responseBodyHash":"abcd1234...","responseStatus":200,"beforeSnapshot":null,"afterSnapshot":null,"diff":[],"aborted":false}],"writeCount":0}
```

### Rotation Policy
The file grows indefinitely. Implement log rotation externally:

```bash
# Example: rotate when > 100 MB
if [ $(stat -f%z logs/impersonation-sessions.jsonl) -gt 104857600 ]; then
  mv logs/impersonation-sessions.jsonl logs/impersonation-sessions-$(date +%Y%m%d).jsonl
  gzip logs/impersonation-sessions-$(date +%Y%m%d).jsonl
fi
```

## Compliance

### GDPR Article 5 (Purpose Limitation)
Every impersonation session requires a `reason` field documenting the justification for access.

### GDPR Article 15 (Right of Access)
Users can request copies of impersonation sessions where they are the `targetUserId` via data export APIs.

### GDPR Article 32 (Security of Processing)
All sessions are audit-logged with tamper-evident timestamps. Admin review actions are themselves audited.

### Retention Period
**Default:** 90 days (configurable via `IMPERSONATION_RETENTION_DAYS`)

After retention period:
- Sessions are archived to cold storage (S3, Glacier)
- File-based logs are gzip-compressed and moved to `logs/archive/`

## Troubleshooting

### Sessions Not Being Recorded

**Symptom:** `getSession(sessionId)` returns `null` even after requests were made.

**Possible Causes:**
1. `req.impersonation` is not populated by auth middleware
   - Check that impersonation token validation is working
   - Verify `req.impersonation` is set before the recorder middleware runs

2. Store initialization failed
   - Check file permissions on `logs/` directory
   - Check disk space

3. Session was opened with a different `sessionId`
   - Ensure auth layer uses the same session ID as the store

### High Memory Usage

**Symptom:** Node.js process memory grows over time.

**Possible Causes:**
1. Sessions are not being closed
   - Implement a TTL watchdog that calls `expireSession()` after token expiry
   - Manually close sessions via admin API

2. Large response bodies
   - Bodies > 256 KB are automatically truncated
   - If issue persists, reduce `MAX_BODY_BYTES` in `impersonationRecorder.ts`

### Diffs Not Being Captured

**Symptom:** `writeCount` is 0 even after POST/PUT/PATCH requests.

**Possible Causes:**
1. Route handler did not call `captureSnapshot()`
   - Add snapshot capture in repository/service layer
   - Example:
     ```typescript
     if (req.impersonation) {
       req.impersonation.captureSnapshot(before, after);
     }
     ```

2. Snapshots were identical
   - If `before` and `after` are deeply equal, no diff is recorded

## Performance Impact

### Overhead Analysis
- **Non-impersonation requests:** ~0.01ms (single `if` check)
- **Impersonation requests (GET):** ~2-5ms (body hashing + async write)
- **Impersonation requests (write with snapshot):** ~5-10ms (+ diff computation)

### Scaling Considerations
- **File store write throughput:** ~500 appends/sec (SSD)
- **Concurrent sessions:** Unlimited (each session is isolated)
- **Session size limit:** ~10 MB per session (200 requests @ 50 KB avg)

For high-throughput scenarios (>1000 req/sec), consider:
1. Switch to database-backed store (PostgreSQL, MongoDB)
2. Use message queue for async writes (RabbitMQ, Kafka)
3. Shard sessions by `adminId` or date range

## Testing

### Unit Tests
```bash
npm test -- impersonationRecorder.test.ts
npm test -- impersonationSessionStore.test.ts
```

### Integration Tests
```bash
npm test -- impersonation-integration.test.ts
```

### Edge Case Tests
```bash
npm test -- impersonation-edge-cases.test.ts
```

### Coverage Target
Minimum 95% line + branch coverage for:
- `src/middleware/impersonationRecorder.ts`
- `src/services/impersonationSessionStore.ts`
- `src/routes/admin.ts` (impersonation endpoints only)

## Future Enhancements

### Planned Features
- [ ] Diff visualization UI in admin dashboard
- [ ] Real-time alerts for high-risk write operations
- [ ] Session replay functionality (read-only mode)
- [ ] Integration with SIEM systems (Splunk, ELK)
- [ ] Signed session manifests (Ed25519) for non-repudiation

### Known Limitations
- Large streaming responses (>256 KB) are truncated
- Snapshot capture is opt-in (requires route handler changes)
- File store does not support concurrent Node.js processes (use DB store instead)

## References

- [GDPR Article 5 (Purpose Limitation)](https://gdpr.eu/article-5-how-to-process-personal-data/)
- [GDPR Article 32 (Security of Processing)](https://gdpr.eu/article-32-security-of-processing/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
