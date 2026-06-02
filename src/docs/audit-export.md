# Audit Export

## Endpoint

`POST /api/v1/admin/audit/export`

Generates a JSONL audit export and returns a short-lived signed download URL plus a SHA-256 integrity hash.

### Authorization

- Requires `x-chronopay-admin-token` header
- The admin token must match `CHRONOPAY_ADMIN_TOKEN`

### Response

```json
{
  "success": true,
  "downloadUrl": "https://example.com/api/v1/admin/audit/export/download?token=...",
  "integrity": "<sha256-hash>",
  "expiresAt": 1680000000000
}
```

## Download URL

`GET /api/v1/admin/audit/export/download?token=<signed token>`

### Headers

- `Content-Type: application/x-ndjson`
- `X-Audit-Export-Integrity-Sha256: <sha256-hash>`

The signed URL is valid only for a short TTL and is protected by HMAC using `CHRONOPAY_AUDIT_EXPORT_SECRET`.
