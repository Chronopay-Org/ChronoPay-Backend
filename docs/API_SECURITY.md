# API Security Documentation

## Overview

ChronoPay API implements a comprehensive authentication and authorization system with multiple security schemes to support different use cases while maintaining security best practices.

## Authentication Methods

### 1. Header-Based Authentication (Primary)
**Scheme**: `chronoPayAuth`

**Headers Required**:
- `x-chronopay-user-id`: User identifier (UUID or alphanumeric)
- `x-chronopay-role`: User role (`customer`, `admin`, `professional`)

**Usage**:
```http
GET /api/v1/slots
x-chronopay-user-id: user-123
x-chronopay-role: customer
```

**Security Notes**:
- Assumes authentication is terminated upstream (API gateway, auth service)
- Headers must be validated by trusted upstream service
- Role-based access control enforced per endpoint

### 2. JWT Bearer Token Authentication
**Scheme**: `bearerAuth`

**Header Required**:
- `Authorization: Bearer <jwt-token>`

**Usage**:
```http
GET /api/v1/slots
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Security Notes**:
- JWT tokens should be obtained from authentication service
- Tokens must be validated for signature and expiration
- Supports stateless authentication

### 3. API Key Authentication (Service-to-Service)
**Scheme**: `apiKeyAuth`

**Header Required**:
- `x-api-key`: API key string

**Usage**:
```http
POST /api/v1/slots
x-api-key: sk_live_1234567890abcdef
```

**Security Notes**:
- Used for service-to-service communication
- API keys should be stored securely and rotated regularly
- Each service should have unique API keys

### 4. Admin Token Authentication
**Scheme**: `adminTokenAuth`

**Header Required**:
- `x-chronopay-admin-token`: Admin token

**Usage**:
```http
POST /api/v1/checkout/sessions/123/complete
x-chronopay-admin-token: admin-secret-token
```

**Security Notes**:
- Used for administrative operations
- Token configured via `CHRONOPAY_ADMIN_TOKEN` environment variable
- Should be long, random, and kept secret

## Role-Based Access Control (RBAC)

### Available Roles
- **`customer`**: Standard customer access
- **`professional`**: Service provider access  
- **`admin`**: Administrative access

### Role Permissions

| Endpoint | Customer | Professional | Admin |
|----------|----------|---------------|-------|
| GET /api/v1/slots | ✅ | ✅ | ✅ |
| POST /api/v1/slots | ❌ | ✅ | ✅ |
| GET /api/v1/slots/:id | ✅ | ✅ | ✅ |
| POST /checkout/sessions | ✅ | ✅ | ✅ |
| GET /checkout/sessions/:id | ✅ | ✅ | ✅ |
| POST /checkout/sessions/:id/complete | ❌ | ❌ | ✅ |
| POST /checkout/sessions/:id/fail | ❌ | ❌ | ✅ |
| POST /checkout/sessions/:id/cancel | ✅ | ✅ | ✅ |

## Error Responses

### 401 Unauthorized
```json
{
  "success": false,
  "error": "Authentication required."
}
```

**Causes**:
- Missing authentication headers
- Invalid or expired tokens
- Missing API key

### 403 Forbidden
```json
{
  "success": false,
  "error": "Role is not authorized for this action."
}
```

**Causes**:
- Insufficient role permissions
- Invalid API key
- Invalid admin token

## Security Best Practices

### For API Consumers
1. **Never expose credentials** in client-side code
2. **Use HTTPS** for all API calls
3. **Validate certificates** and implement certificate pinning
4. **Implement proper error handling** without exposing sensitive information
5. **Use short-lived tokens** and implement refresh mechanisms
6. **Rotate API keys** regularly

### For API Implementation
1. **Never log sensitive data** (passwords, tokens, API keys)
2. **Implement rate limiting** to prevent abuse
3. **Use secure headers** (CORS, CSP, HSTS)
4. **Validate all inputs** and sanitize outputs
5. **Implement audit logging** for security events
6. **Monitor for suspicious activity**

## OpenAPI Documentation

The API includes comprehensive OpenAPI 3.0.0 documentation with:

- **Security schemes** for all authentication methods
- **Error response schemas** for 401/403 responses
- **Request/response examples** for all endpoints
- **Security requirements** documented per endpoint

Access the documentation at: `/api-docs`

## Testing

Security features are covered by comprehensive tests in `src/__tests__/swagger.test.ts`:

- Authentication flow testing
- Authorization validation
- Error response verification
- Security header validation
- Malformed input handling

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CHRONOPAY_ADMIN_TOKEN` | Admin token for administrative operations | Yes |
| `NODE_ENV` | Environment mode (development/production/test) | No |

## Migration Guide

### From Basic Auth to Header-Based Auth
1. Replace username/password with `x-chronopay-user-id` header
2. Add `x-chronopay-role` header for RBAC
3. Update error handling for 401/403 responses
4. Remove basic auth headers from requests

### Adding API Key Authentication
1. Generate unique API keys for each service
2. Add `x-api-key` header to service requests
3. Configure API key validation in middleware
4. Update API documentation

## Security Considerations

### Token Security
- JWT tokens should use strong signing algorithms (RS256, ES256)
- Implement proper token expiration (short-lived)
- Use refresh tokens for long-term sessions
- Validate token claims thoroughly

### API Key Security
- Use cryptographically strong random keys
- Implement key rotation policies
- Store keys securely (environment variables, secret management)
- Audit key usage regularly

### Header Security
- Validate header format and content
- Sanitize header values to prevent injection
- Implement header size limits
- Log authentication attempts (without sensitive data)

## Compliance

This implementation follows security best practices for:

- **OWASP API Security Top 10**
- **NIST Cybersecurity Framework**
- **GDPR data protection principles**
- **PCI DSS requirements** (for payment processing)

## Support

For security-related issues or questions:

1. Review this documentation
2. Check the OpenAPI specification at `/api-docs`
3. Run the test suite to verify security features
4. Contact the security team for sensitive issues

---

**Last Updated**: 2024-01-01  
**Version**: 1.0.0  
**Security Classification**: Internal Use Only
