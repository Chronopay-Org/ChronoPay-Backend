# Buyer Profile API

Base path: `/api/v1/buyer-profiles`

All endpoints require a valid JWT (`Authorization: Bearer <token>`).

---

## Input Sanitization

All write endpoints (`POST`, `PATCH`) enforce the following rules before the request reaches the controller:

### Field allowlist

Only the fields listed below are accepted. Any additional key in the request body causes an immediate `400` response.

| Field | Create | Update |
|---|---|---|
| `fullName` | required | optional |
| `email` | required | optional |
| `phoneNumber` | required | optional |
| `address` | optional | optional |
| `avatarUrl` | optional | optional |

### Normalization

| Field | Rule |
|---|---|
| `fullName` | Unicode whitespace (including `\u00a0`, `\u2003`, etc.) collapsed to single ASCII space and trimmed; `<` and `>` stripped |
| `email` | Trimmed, lowercased |
| `phoneNumber` | Trimmed |
| `address` | Unicode whitespace collapsed, trimmed; `<` and `>` stripped |
| `avatarUrl` | Trimmed |

### Length limits

| Field | Min | Max |
|---|---|---|
| `fullName` | 2 chars | 100 chars |
| `email` | — | 255 chars |
| `phoneNumber` | 7 chars | 20 chars |
| `address` | — | 500 chars |
| `avatarUrl` | — | 2048 chars |

### Character set restrictions

| Field | Allowed characters |
|---|---|
| `fullName` | Unicode letters (`\p{L}`), combining marks (`\p{M}`), spaces, hyphens `-`, apostrophes `'`, periods `.` |
| `phoneNumber` | Digits `0-9`, spaces, hyphens `-`, plus `+`, parentheses `()` |

---

## Endpoints

### `POST /api/v1/buyer-profiles`

Create a buyer profile for the authenticated user.

**Auth:** user

**Request body**

```json
{
  "fullName": "Jane O'Brien",
  "email": "jane@example.com",
  "phoneNumber": "+1234567890",
  "address": "123 Main St",
  "avatarUrl": "https://cdn.example.com/avatar.jpg"
}
```

**Responses**

| Status | Meaning |
|---|---|
| `201` | Profile created |
| `400` | Validation failed (unknown field, bad format, length exceeded) |
| `401` | Not authenticated |
| `409` | User already has a profile, or email already in use |

---

### `GET /api/v1/buyer-profiles/me`

Get the authenticated user's own profile.

**Auth:** user

**Responses:** `200`, `401`, `404`

---

### `GET /api/v1/buyer-profiles`

List all profiles (admin only).

**Auth:** admin

**Query params:** `userId`, `email`, `fullName`, `page` (default 1), `limit` (default 10, max 100)

**Responses:** `200`, `401`, `403`

---

### `GET /api/v1/buyer-profiles/:id`

Get a profile by UUID. Owner or admin only.

**Auth:** user (own profile) or admin

**Responses:** `200`, `400` (invalid UUID), `401`, `403`, `404`

---

### `PATCH /api/v1/buyer-profiles/:id`

Partial update. At least one field required. Owner or admin only.

**Auth:** user (own profile) or admin

**Request body** — any subset of create fields (same allowlist and rules apply)

**Responses:** `200`, `400`, `401`, `403`, `404`, `409`

---

### `DELETE /api/v1/buyer-profiles/:id`

Soft-delete a profile. Owner or admin only.

**Auth:** user (own profile) or admin

**Responses:** `200`, `400`, `401`, `403`, `404`

---

## Error envelope

All error responses use the standard envelope:

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    { "field": "fullName", "message": "Full name contains invalid characters" }
  ]
}
```

For unknown-field rejections:

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    { "field": "body", "message": "Unknown field(s): injectedField" }
  ]
}
```

---

## Security notes

- **Allowlist-first**: unknown fields are rejected at the DTO layer before any business logic runs, preventing mass-assignment attacks.
- **Unicode normalization**: all whitespace variants are collapsed to ASCII space before storage, preventing homoglyph-based bypass of duplicate detection.
- **No PII in error messages**: validation errors reference field names and constraint descriptions only — no raw input values are echoed back.
- **Email lowercased at ingress**: prevents duplicate accounts via case variation.
- **Soft delete**: profiles are never hard-deleted via the API; `deletedAt` is set and the record is excluded from all queries.
