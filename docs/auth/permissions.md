# Fine-Grained RBAC Permission Catalog

## Overview

ChronoPay Backend implements a fine-grained Role-Based Access Control (RBAC) system using a permission catalog with wildcard grant syntax. This allows operations teams to express least-privilege access policies precisely and audit permission changes effectively.

## Architecture

### Components

1. **Permission Catalog** (`src/config/permissions.json`)
   - Defines all available permissions in the system
   - Permissions follow the format: `resource:action`
   - Examples: `bookings:create`, `users:delete`, `audit:read`

2. **Permission Grants** (`src/config/permission-grants.json`)
   - Maps roles to their granted permissions
   - Supports wildcard syntax for flexible permission assignment
   - All grants are version-controlled and require code review

3. **Grant Evaluator** (`src/services/permissionCatalog.ts`)
   - Evaluates permission requests against grants
   - Implements wildcard matching logic
   - Provides audit logging for all permission checks

4. **RBAC Middleware** (`src/middleware/rbac.ts`)
   - Express middleware for protecting routes
   - Integrates with the permission catalog
   - Supports both role-based and permission-based checks

## Permission Format

Permissions use a hierarchical naming convention:

```
resource:action
```

### Examples

- `bookings:create` - Create a booking
- `bookings:read` - Read booking details
- `users:delete` - Delete a user
- `audit:export` - Export audit logs
- `system:configure` - Configure system settings

## Grant Syntax

### Wildcard Patterns

The system supports three types of grants:

#### 1. Full Wildcard (`*`)
Grants all permissions in the system.

```json
{
  "grants": {
    "admin": ["*"]
  }
}
```

#### 2. Resource Wildcard (`resource:*`)
Grants all actions on a specific resource.

```json
{
  "grants": {
    "professional": ["slots:*", "bookings:read"]
  }
}
```

This grants:
- `slots:create`
- `slots:read`
- `slots:update`
- `slots:delete`
- `slots:list`
- `bookings:read` (exact match)

#### 3. Exact Permission
Grants a specific permission only.

```json
{
  "grants": {
    "customer": ["bookings:create", "bookings:read"]
  }
}
```

## Default Role Permissions

### Admin
- **Grants**: `*` (full access)
- **Use Case**: System administrators with complete access

### Support
- **Grants**: 
  - `bookings:*` (all booking operations)
  - `slots:read`, `slots:list` (read slot information)
  - `users:read`, `users:list` (read user information)
  - `payments:read`, `payments:list` (read payment information)
  - `audit:read` (read audit logs)
  - `reports:read` (read reports)
- **Use Case**: Support staff helping customers with bookings

### Auditor
- **Grants**:
  - `audit:*` (all audit operations)
  - `reports:read` (read reports)
- **Use Case**: Compliance and audit personnel

### Professional
- **Grants**:
  - `bookings:read`, `bookings:list`, `bookings:update`, `bookings:cancel`
  - `slots:*` (full slot management)
  - `users:read` (read user information)
  - `payments:read`, `payments:list` (read payment information)
- **Use Case**: Service providers managing their availability and bookings

### Customer
- **Grants**:
  - `bookings:create`, `bookings:read`, `bookings:cancel`
  - `slots:read`, `slots:list`
  - `users:read`
- **Use Case**: End users booking services

## Usage

### Protecting Routes with Permissions

Use the `requirePermission` middleware to protect routes:

```typescript
import { requirePermission } from './middleware/rbac.js';

// Require exact permission
app.post('/api/bookings', 
  requirePermission('bookings:create'),
  bookingController.create
);

// Multiple routes with different permissions
app.get('/api/users', 
  requirePermission('users:list'),
  userController.list
);

app.delete('/api/users/:id',
  requirePermission('users:delete'),
  userController.delete
);
```

### Getting User Permissions

Retrieve all effective permissions for a role:

```typescript
import { getUserPermissions } from './middleware/rbac.js';

const permissions = getUserPermissions('professional');
// Returns: Set(['slots:create', 'slots:read', 'slots:update', ...])
```

### Programmatic Permission Checks

Check permissions programmatically:

```typescript
import { hasPermission, permissionCatalog } from './services/permissionCatalog.js';

const canDelete = hasPermission(
  permissionCatalog,
  'customer',
  'users:delete'
);
// Returns: false
```

## Audit Logging

All permission checks are automatically audited:

### Permission Check Audit
```json
{
  "action": "PERMISSION_GRANTED",
  "timestamp": "2026-07-28T10:15:30.000Z",
  "context": {
    "role": "professional",
    "permission": "slots:create",
    "granted": true
  },
  "actorIp": "192.168.1.100",
  "resource": "/api/slots",
  "status": 200
}
```

### Grant Change Audit
```json
{
  "action": "PERMISSION_GRANT_CHANGE",
  "timestamp": "2026-07-28T10:15:30.000Z",
  "context": {
    "changeType": "MODIFY",
    "role": "support",
    "grants": ["bookings:*", "users:read"],
    "actorId": "admin_user_123"
  },
  "status": 200
}
```

## Security Best Practices

### 1. Least Privilege Principle
Grant only the minimum permissions required for each role:

```json
// ✅ Good - Specific permissions
{
  "customer": ["bookings:create", "bookings:read", "bookings:cancel"]
}

// ❌ Avoid - Overly broad unless necessary
{
  "customer": ["*"]
}
```

### 2. Code Review for Grant Changes
All changes to `permission-grants.json` must:
- Be committed to version control
- Undergo peer review
- Include justification in the commit message
- Trigger audit events

### 3. Regular Permission Audits
- Review audit logs regularly for suspicious permission denials
- Analyze which permissions are actually used
- Remove unused permissions from grants
- Look for privilege escalation attempts

### 4. Wildcard Usage
Use wildcards judiciously:
- Full wildcard (`*`) should be limited to admin roles
- Resource wildcards (`resource:*`) for operational roles
- Prefer exact permissions for external-facing roles

## Testing

The permission system includes comprehensive tests:

```bash
# Run all tests
npm test

# Run permission catalog tests
npm test -- permissionCatalog.test.ts

# Run RBAC integration tests
npm test -- rbac.permission.test.ts

# Check test coverage
npm run test:coverage
```

### Test Coverage Requirements

- Minimum 95% coverage for permission-related code
- Edge cases covered:
  - Overlapping grants
  - Wildcard misuse attempts
  - Permission revocation mid-request
  - Case sensitivity handling
  - Invalid permission/role handling

## Adding New Permissions

### 1. Define the Permission

Add to `src/config/permissions.json`:

```json
{
  "permissions": [
    "existing:permission",
    "newresource:action"
  ]
}
```

### 2. Grant to Roles

Update `src/config/permission-grants.json`:

```json
{
  "grants": {
    "role_name": [
      "existing:grant",
      "newresource:action"
    ]
  }
}
```

### 3. Protect Routes

Apply the middleware:

```typescript
app.post('/api/newresource',
  requirePermission('newresource:action'),
  controller.action
);
```

### 4. Add Tests

Create tests for the new permission:

```typescript
it('should allow role_name to access newresource:action', async () => {
  expect(hasPermission(catalog, 'role_name', 'newresource:action')).toBe(true);
});
```

### 5. Update Documentation

Document the new permission and its use case.

## Troubleshooting

### Permission Denied Errors

1. **Check Role**: Verify the user has the correct role header
2. **Check Grants**: Ensure the role has the required grant in `permission-grants.json`
3. **Check Permission**: Verify the permission exists in `permissions.json`
4. **Check Wildcards**: Ensure wildcard patterns are correctly formed
5. **Check Audit Logs**: Review audit logs for details on the denial

### Common Issues

#### Issue: Permission denied despite wildcard grant
```
Role has "booking:*" but "bookings:create" is denied
```
**Solution**: Check for typos - "booking" vs "bookings"

#### Issue: Case sensitivity problems
```
Role "Admin" not matching grants for "admin"
```
**Solution**: The system normalizes to lowercase automatically, but ensure consistency

#### Issue: Permission not found
```
requirePermission throws "unknown permission"
```
**Solution**: Add the permission to `permissions.json` first

## Migration from Role-Only Checks

Existing role-based middleware (`requireRole`) continues to work alongside permission-based checks:

```typescript
// Old style - still supported
app.get('/admin', requireRole('admin'), handler);

// New style - recommended
app.get('/admin', requirePermission('system:configure'), handler);
```

Gradually migrate to permission-based checks for better granularity.

## API Reference

### `requirePermission(permission: Permission)`
Express middleware that checks if the requesting user has a specific permission.

**Parameters:**
- `permission`: The required permission string (e.g., 'bookings:create')

**Returns:** Express middleware function

**Throws:**
- Error if permission is unknown or empty

### `getUserPermissions(role: string): ReadonlySet<Permission>`
Gets all effective permissions for a given role by expanding wildcards.

**Parameters:**
- `role`: The role name

**Returns:** Set of all permissions the role has access to

### `hasPermission(catalog: PermissionCatalog, role: string, permission: string): boolean`
Checks if a role has a specific permission.

**Parameters:**
- `catalog`: The permission catalog instance
- `role`: The role name
- `permission`: The permission to check

**Returns:** `true` if the role has the permission, `false` otherwise

### `matchesGrant(permission: string, grant: string): boolean`
Matches a permission against a grant pattern with wildcard support.

**Parameters:**
- `permission`: The permission to check
- `grant`: The grant pattern (with optional wildcards)

**Returns:** `true` if the grant matches the permission

## Conclusion

The fine-grained RBAC permission catalog provides:
- **Precision**: Express least-privilege policies exactly
- **Flexibility**: Wildcard syntax for efficient permission management
- **Auditability**: Complete audit trail of permission checks and changes
- **Security**: Built-in validation and normalization
- **Maintainability**: Version-controlled, code-reviewed grants

For questions or issues, refer to the audit logs and test suite for guidance.
