# Impersonation Session Recording - Examples

This document provides practical examples for implementing and using the impersonation session recording feature.

## Table of Contents

1. [Basic Setup](#basic-setup)
2. [Capturing Snapshots in Route Handlers](#capturing-snapshots-in-route-handlers)
3. [Repository Layer Integration](#repository-layer-integration)
4. [Reviewing Sessions](#reviewing-sessions)
5. [Common Patterns](#common-patterns)

## Basic Setup

### 1. Enable Impersonation in Auth Middleware

The auth middleware should detect impersonation tokens and populate `req.impersonation`:

```typescript
// src/middleware/auth.ts (example)
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if this is an impersonation token
    if (decoded.impersonation) {
      // Populate impersonation context
      req.impersonation = {
        sessionId: decoded.impersonation.sessionId,
        adminId: decoded.impersonation.adminId,
        targetUserId: decoded.sub,  // The user being impersonated
        captureSnapshot: () => {},  // Will be replaced by recorder middleware
      };
      
      // Also set req.user to the impersonated user for normal flow
      req.user = { userId: decoded.sub, role: decoded.role };
    } else {
      // Normal authentication
      req.user = { userId: decoded.sub, role: decoded.role };
    }
    
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

### 2. Verify Middleware Order in app.ts

```typescript
// src/app.ts
app.use(authenticateToken);           // 1. Auth populates req.impersonation
app.use(impersonationRecorder());     // 2. Recorder intercepts if impersonation is active
app.use('/api', apiRoutes);           // 3. Application routes
```

## Capturing Snapshots in Route Handlers

### Example 1: Update User Profile

```typescript
// src/routes/users.ts
import { Router } from 'express';

const router = Router();

router.put('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const updates = req.body;
  
  try {
    // Fetch current state
    const beforeUpdate = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    const before = beforeUpdate.rows[0];
    
    // Apply updates
    const afterUpdate = await db.query(
      'UPDATE users SET email = $1, name = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [updates.email || before.email, updates.name || before.name, userId]
    );
    const after = afterUpdate.rows[0];
    
    // Capture snapshot if impersonating
    if (req.impersonation) {
      // Remove sensitive fields before capturing
      const beforeSafe = { ...before };
      const afterSafe = { ...after };
      delete beforeSafe.password_hash;
      delete afterSafe.password_hash;
      
      req.impersonation.captureSnapshot(beforeSafe, afterSafe);
    }
    
    res.json({ success: true, user: after });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

export default router;
```

### Example 2: Delete Resource

```typescript
router.delete('/resources/:resourceId', async (req, res) => {
  const { resourceId } = req.params;
  
  try {
    // Fetch current state before deletion
    const result = await db.query(
      'SELECT * FROM resources WHERE id = $1',
      [resourceId]
    );
    const before = result.rows[0];
    
    if (!before) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    
    // Perform deletion
    await db.query('DELETE FROM resources WHERE id = $1', [resourceId]);
    
    // Capture snapshot (after is null for deletions)
    if (req.impersonation) {
      req.impersonation.captureSnapshot(before, { ...before, deleted: true });
    }
    
    res.json({ success: true, message: 'Resource deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Deletion failed' });
  }
});
```

### Example 3: Bulk Update

```typescript
router.post('/users/bulk-update', async (req, res) => {
  const { userIds, updates } = req.body;
  
  try {
    // Fetch all affected users before update
    const beforeResult = await db.query(
      'SELECT * FROM users WHERE id = ANY($1)',
      [userIds]
    );
    const beforeMap = new Map(beforeResult.rows.map(u => [u.id, u]));
    
    // Perform updates
    const updatePromises = userIds.map(userId =>
      db.query(
        'UPDATE users SET status = $1 WHERE id = $2 RETURNING *',
        [updates.status, userId]
      )
    );
    
    const afterResults = await Promise.all(updatePromises);
    const afterMap = new Map(afterResults.map(r => [r.rows[0].id, r.rows[0]]));
    
    // Capture snapshot (aggregate view)
    if (req.impersonation) {
      const before = { users: Array.from(beforeMap.values()) };
      const after = { users: Array.from(afterMap.values()) };
      req.impersonation.captureSnapshot(before, after);
    }
    
    res.json({ success: true, updatedCount: userIds.length });
  } catch (err) {
    res.status(500).json({ error: 'Bulk update failed' });
  }
});
```

## Repository Layer Integration

For cleaner separation, implement snapshot capture in the repository layer:

### Example Repository

```typescript
// src/repositories/userRepository.ts
import type { Request } from 'express';

export class UserRepository {
  async updateUser(userId: string, updates: any, req?: Request) {
    // Fetch before state
    const beforeResult = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    const before = beforeResult.rows[0];
    
    // Perform update
    const afterResult = await db.query(
      'UPDATE users SET email = $1, name = $2 WHERE id = $3 RETURNING *',
      [updates.email, updates.name, userId]
    );
    const after = afterResult.rows[0];
    
    // Automatic snapshot capture if request context provided
    if (req?.impersonation) {
      this.captureSnapshot(req, before, after);
    }
    
    return after;
  }
  
  private captureSnapshot(req: Request, before: any, after: any) {
    // Remove sensitive fields
    const sanitize = (obj: any) => {
      const clean = { ...obj };
      delete clean.password_hash;
      delete clean.refresh_token;
      delete clean.session_secret;
      return clean;
    };
    
    req.impersonation!.captureSnapshot(
      sanitize(before),
      sanitize(after)
    );
  }
}
```

### Usage in Route Handler

```typescript
router.put('/users/:userId', async (req, res) => {
  const userRepo = new UserRepository();
  
  try {
    // Pass req to enable automatic snapshot capture
    const updated = await userRepo.updateUser(
      req.params.userId,
      req.body,
      req  // <-- Enables impersonation tracking
    );
    
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});
```

## Reviewing Sessions

### 1. List Active Impersonation Sessions

```bash
#!/bin/bash
# scripts/list-active-impersonations.sh

ADMIN_TOKEN="${ADMIN_TOKEN:-your-admin-token}"
API_URL="${API_URL:-http://localhost:3001}"

curl -s \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "$API_URL/api/v1/admin/impersonation/sessions" \
  | jq '.sessions[] | select(.status == "active") | {sessionId, adminId, targetUserId, startedAt, requestCount, writeCount}'
```

### 2. Get Full Session Details

```bash
#!/bin/bash
# scripts/review-impersonation-session.sh

SESSION_ID="$1"
ADMIN_TOKEN="${ADMIN_TOKEN:-your-admin-token}"
API_URL="${API_URL:-http://localhost:3001}"

if [ -z "$SESSION_ID" ]; then
  echo "Usage: $0 <session-id>"
  exit 1
fi

curl -s \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "$API_URL/api/v1/admin/impersonation/sessions/$SESSION_ID" \
  | jq '.'
```

### 3. Export Session to JSON File

```bash
#!/bin/bash
# scripts/export-impersonation-session.sh

SESSION_ID="$1"
OUTPUT_FILE="${2:-session-${SESSION_ID}.json}"
ADMIN_TOKEN="${ADMIN_TOKEN:-your-admin-token}"
API_URL="${API_URL:-http://localhost:3001}"

curl -s \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "$API_URL/api/v1/admin/impersonation/sessions/$SESSION_ID" \
  > "$OUTPUT_FILE"

echo "Session exported to $OUTPUT_FILE"
```

### 4. Filter Sessions by Admin

```bash
curl -s \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "http://localhost:3001/api/v1/admin/impersonation/sessions?adminId=admin@example.com&limit=20" \
  | jq '.sessions'
```

### 5. Find Sessions for a Specific User

```bash
curl -s \
  -H "x-chronopay-admin-token: $ADMIN_TOKEN" \
  "http://localhost:3001/api/v1/admin/impersonation/sessions?targetUserId=user123" \
  | jq '.sessions'
```

## Common Patterns

### Pattern 1: Conditional Snapshot Capture

Only capture snapshots when specific fields change:

```typescript
router.patch('/users/:userId/preferences', async (req, res) => {
  const before = await getUserPreferences(req.params.userId);
  const after = await updateUserPreferences(req.params.userId, req.body);
  
  // Only capture if sensitive fields changed
  const sensitiveFields = ['notification_email', 'phone_number', 'address'];
  const changedSensitiveFields = sensitiveFields.some(
    field => before[field] !== after[field]
  );
  
  if (req.impersonation && changedSensitiveFields) {
    req.impersonation.captureSnapshot(before, after);
  }
  
  res.json({ success: true, preferences: after });
});
```

### Pattern 2: Nested Resource Updates

```typescript
router.put('/orders/:orderId/items/:itemId', async (req, res) => {
  const { orderId, itemId } = req.params;
  
  // Capture both order and item state
  const beforeOrder = await getOrder(orderId);
  const beforeItem = beforeOrder.items.find(i => i.id === itemId);
  
  const updatedItem = await updateOrderItem(orderId, itemId, req.body);
  const afterOrder = await getOrder(orderId);
  
  if (req.impersonation) {
    req.impersonation.captureSnapshot(
      { order: beforeOrder, item: beforeItem },
      { order: afterOrder, item: updatedItem }
    );
  }
  
  res.json({ success: true, item: updatedItem });
});
```

### Pattern 3: Transaction Rollback Scenarios

```typescript
router.post('/transfers', async (req, res) => {
  const { fromAccountId, toAccountId, amount } = req.body;
  
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Capture before state
    const [fromBefore, toBefore] = await Promise.all([
      client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [fromAccountId]),
      client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [toAccountId]),
    ]);
    
    // Perform transfer
    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromAccountId]);
    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toAccountId]);
    
    // Capture after state
    const [fromAfter, toAfter] = await Promise.all([
      client.query('SELECT * FROM accounts WHERE id = $1', [fromAccountId]),
      client.query('SELECT * FROM accounts WHERE id = $1', [toAccountId]),
    ]);
    
    await client.query('COMMIT');
    
    // Capture snapshot AFTER successful commit
    if (req.impersonation) {
      req.impersonation.captureSnapshot(
        { from: fromBefore.rows[0], to: toBefore.rows[0] },
        { from: fromAfter.rows[0], to: toAfter.rows[0] }
      );
    }
    
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    // No snapshot captured on rollback
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});
```

### Pattern 4: Middleware-Based Snapshot Helper

Create a reusable helper for common update patterns:

```typescript
// src/middleware/snapshotHelper.ts
export function withSnapshot<T>(
  fetchBefore: () => Promise<T>,
  operation: () => Promise<T>,
  fetchAfter?: () => Promise<T>
) {
  return async (req: Request) => {
    const before = await fetchBefore();
    const result = await operation();
    const after = fetchAfter ? await fetchAfter() : result;
    
    if (req.impersonation) {
      req.impersonation.captureSnapshot(before, after);
    }
    
    return result;
  };
}

// Usage:
router.put('/users/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const result = await withSnapshot(
      () => userRepo.findById(userId),
      () => userRepo.update(userId, req.body)
    )(req);
    
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});
```

## Testing Your Implementation

### Unit Test for Route Handler

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app';

describe('User update with impersonation', () => {
  it('should capture snapshot when impersonating', async () => {
    const sessionId = 'test-session-001';
    const impersonationToken = generateImpersonationToken({
      sessionId,
      adminId: 'admin@example.com',
      targetUserId: 'user123',
    });
    
    const response = await request(app)
      .put('/api/v1/users/user123')
      .set('Authorization', `Bearer ${impersonationToken}`)
      .send({ email: 'newemail@example.com' })
      .expect(200);
    
    // Verify session was recorded
    const session = await store.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.requests).toHaveLength(1);
    expect(session!.requests[0].diff.length).toBeGreaterThan(0);
  });
});
```

## Troubleshooting Checklist

- [ ] `req.impersonation` is populated by auth middleware
- [ ] Impersonation recorder is mounted AFTER auth middleware
- [ ] `captureSnapshot()` is called BEFORE sending response
- [ ] Snapshots exclude sensitive fields (passwords, tokens)
- [ ] Session is opened before requests are made
- [ ] Admin token is valid for review API calls
- [ ] File store directory (`logs/`) has write permissions

## Next Steps

1. Review [full documentation](./impersonation-recording.md)
2. Implement snapshot capture in your existing routes
3. Add admin dashboard for session review
4. Set up automated archival for expired sessions
