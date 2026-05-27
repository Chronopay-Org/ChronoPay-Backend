# Buyer Profile Module

## Overview

The Buyer Profile module provides a complete CRUD (Create, Read, Update, Delete) system for managing user profiles in the ChronoPay backend. It implements secure, validated, and well-tested endpoints following RESTful API best practices.

## Architecture

The module follows a clean architecture pattern with clear separation of concerns:

```
src/buyer-profile/
├── __tests__/                    # Test files
│   ├── buyer-profile.service.test.ts
│   ├── buyer-profile.controller.test.ts
│   └── buyer-profile.dto.test.ts
├── dto/
│   └── buyer-profile.dto.ts      # Data Transfer Objects and validation
├── types/
│   └── buyer-profile.types.ts    # TypeScript interfaces and types
├── buyer-profile.service.ts      # Business logic layer
├── buyer-profile.controller.ts   # HTTP request handlers
├── buyer-profile.routes.ts       # Route definitions
├── index.ts                      # Module exports
└── README.md                     # This file
```

## API Endpoints

### Base URL: `/api/v1/buyer-profiles`

---

### 1. Create Buyer Profile

**Endpoint:** `POST /api/v1/buyer-profiles`

**Description:** Create a new buyer profile for the authenticated user.

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
  "fullName": "John Doe",
  "email": "john.doe@example.com",
  "phoneNumber": "+1234567890",
  "address": "123 Main St, City, Country",  // Optional
  "avatarUrl": "https://example.com/avatar.jpg"  // Optional
}
```

**Validation Rules:**
- `fullName`: Required, 2-100 characters
- `email`: Required, valid email format, max 255 characters, must be unique
- `phoneNumber`: Required, valid phone format (10-20 characters)
- `address`: Optional, max 500 characters
- `avatarUrl`: Optional, valid URL format

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-1",
    "fullName": "John Doe",
    "email": "john.doe@example.com",
    "phoneNumber": "+1234567890",
    "address": "123 Main St, City, Country",
    "avatarUrl": "https://example.com/avatar.jpg",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "deletedAt": null
  },
  "message": "Buyer profile created successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Validation failed
- `401 Unauthorized`: Authentication required
- `409 Conflict`: User already has a profile or email is already in use

---

### 2. Get Current User's Profile

**Endpoint:** `GET /api/v1/buyer-profiles/me`

**Description:** Retrieve the authenticated user's profile.

**Authentication:** Required (Bearer token)

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-1",
    "fullName": "John Doe",
    "email": "john.doe@example.com",
    "phoneNumber": "+1234567890",
    "address": "123 Main St, City, Country",
    "avatarUrl": "https://example.com/avatar.jpg",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "deletedAt": null
  }
}
```

**Error Responses:**
- `401 Unauthorized`: Authentication required
- `404 Not Found`: No profile found for the current user

---

### 3. Get Profile by ID

**Endpoint:** `GET /api/v1/buyer-profiles/:id`

**Description:** Retrieve a buyer profile by its ID.

**Authentication:** Required (Bearer token)

**Authorization:**
- Users can view their own profile
- Admins can view any profile

**Path Parameters:**
- `id`: UUID of the profile

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-1",
    "fullName": "John Doe",
    "email": "john.doe@example.com",
    "phoneNumber": "+1234567890",
    "address": "123 Main St, City, Country",
    "avatarUrl": "https://example.com/avatar.jpg",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "deletedAt": null
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid UUID format
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Access denied (non-admin trying to view another user's profile)
- `404 Not Found`: Profile not found

---

### 4. List All Profiles (Admin Only)

**Endpoint:** `GET /api/v1/buyer-profiles`

**Description:** List all buyer profiles with optional filtering and pagination.

**Authentication:** Required (Bearer token)

**Authorization:** Admin only

**Query Parameters:**
- `userId` (optional): Filter by user ID
- `email` (optional): Filter by email
- `fullName` (optional): Filter by full name (partial match)
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10, max: 100)

**Example Request:**
```
GET /api/v1/buyer-profiles?page=1&limit=10&fullName=John
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "userId": "user-1",
      "fullName": "John Doe",
      "email": "john.doe@example.com",
      "phoneNumber": "+1234567890",
      "address": "123 Main St, City, Country",
      "avatarUrl": "https://example.com/avatar.jpg",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z",
      "deletedAt": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

**Error Responses:**
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Insufficient permissions (non-admin)

---

### 5. Update Profile

**Endpoint:** `PATCH /api/v1/buyer-profiles/:id`

**Description:** Update a buyer profile (partial updates supported).

**Authentication:** Required (Bearer token)

**Authorization:**
- Users can update their own profile
- Admins can update any profile

**Path Parameters:**
- `id`: UUID of the profile

**Request Body (at least one field required):**
```json
{
  "fullName": "John Updated",
  "email": "john.updated@example.com",
  "phoneNumber": "+9999999999",
  "address": "456 New St, City, Country",
  "avatarUrl": "https://example.com/new-avatar.jpg"
}
```

**Validation Rules:**
- `fullName`: Optional, 2-100 characters
- `email`: Optional, valid email format, max 255 characters, must be unique
- `phoneNumber`: Optional, valid phone format (10-20 characters)
- `address`: Optional, max 500 characters
- `avatarUrl`: Optional, valid URL format

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "user-1",
    "fullName": "John Updated",
    "email": "john.updated@example.com",
    "phoneNumber": "+9999999999",
    "address": "456 New St, City, Country",
    "avatarUrl": "https://example.com/new-avatar.jpg",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:01.000Z",
    "deletedAt": null
  },
  "message": "Profile updated successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Validation failed or no fields provided
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Access denied (non-owner/non-admin)
- `404 Not Found`: Profile not found
- `409 Conflict`: Email is already in use by another profile

---

### 6. Delete Profile

**Endpoint:** `DELETE /api/v1/buyer-profiles/:id`

**Description:** Soft delete a buyer profile.

**Authentication:** Required (Bearer token)

**Authorization:**
- Users can delete their own profile
- Admins can delete any profile

**Path Parameters:**
- `id`: UUID of the profile

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile deleted successfully"
}
```

**Error Responses:**
- `401 Unauthorized`: Authentication required
- `403 Forbidden`: Access denied (non-owner/non-admin)
- `404 Not Found`: Profile not found

---

## Security Features

### Authentication
- All endpoints require JWT authentication via Bearer token
- Token must be provided in the `Authorization` header

### Authorization
- **Role-Based Access Control (RBAC):**
  - `USER`: Can manage their own profile
  - `ADMIN`: Can manage any profile and list all profiles

- **Horizontal Privilege Escalation Prevention:**
  - Users can only access/modify their own profiles
  - Admins can access/modify any profile

### Input Validation
- All inputs are validated using DTOs
- Email format validation
- Phone number format validation
- URL format validation for avatar URLs
- String length limits to prevent abuse
- Input sanitization (trimming, XSS prevention)

### Data Protection
- Soft delete implementation (profiles are not permanently deleted)
- Email uniqueness enforcement
- One profile per user enforcement

---

## Data Model

### Buyer Profile Entity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | UUID | Auto-generated | Unique identifier |
| userId | string | Yes | Linked to authenticated user |
| fullName | string | Yes | User's full name |
| email | string | Yes | User's email (unique) |
| phoneNumber | string | Yes | User's phone number |
| address | string | No | User's address |
| avatarUrl | string | No | URL to user's avatar |
| createdAt | Date | Auto-generated | Creation timestamp |
| updatedAt | Date | Auto-generated | Last update timestamp |
| deletedAt | Date | No | Soft delete timestamp |

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error type",
  "message": "Human-readable error message"
}
```

For validation errors, additional details are provided:

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [
    {
      "field": "email",
      "message": "Invalid email format"
    }
  ]
}
```

---

## Testing

The module includes comprehensive test coverage:

### Unit Tests (Service Layer)
- Create profile operations
- Read operations (by ID, by userId, by email)
- List operations with filtering and pagination
- Update operations
- Delete operations (soft delete)
- Edge cases and error handling

### Integration Tests (Controller Layer)
- All CRUD endpoints
- Authentication and authorization
- Input validation
- Error responses
- Edge cases

### DTO Tests
- Validation functions
- Transformation functions
- Edge cases

**Test Coverage:** 95%+

**Running Tests:**
```bash
npm test
```

---

## Usage Examples

### Using cURL

#### Create Profile
```bash
curl -X POST http://localhost:3001/api/v1/buyer-profiles \
  -H "Authorization: Bearer user-1" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Doe",
    "email": "john.doe@example.com",
    "phoneNumber": "+1234567890",
    "address": "123 Main St",
    "avatarUrl": "https://example.com/avatar.jpg"
  }'
```

#### Get Current User's Profile
```bash
curl -X GET http://localhost:3001/api/v1/buyer-profiles/me \
  -H "Authorization: Bearer user-1"
```

#### Get Profile by ID
```bash
curl -X GET http://localhost:3001/buyer-profiles/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer user-1"
```

#### Update Profile
```bash
curl -X PATCH http://localhost:3001/api/v1/buyer-profiles/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer user-1" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Updated",
    "phoneNumber": "+9999999999"
  }'
```

#### Delete Profile
```bash
curl -X DELETE http://localhost:3001/api/v1/buyer-profiles/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer user-1"
```

#### List All Profiles (Admin)
```bash
curl -X GET "http://localhost:3001/api/v1/buyer-profiles?page=1&limit=10" \
  -H "Authorization: Bearer admin-1"
```

---

## Dependencies

- `uuid`: For generating unique profile IDs
- `express`: Web framework
- TypeScript types for Express

---

## Future Enhancements

1. **Database Integration:** Replace in-memory store with TypeORM/Prisma
2. **Email Verification:** Add email verification flow
3. **Profile Pictures:** Implement file upload for avatars
4. **Audit Logging:** Track all profile changes
5. **Rate Limiting:** Add rate limiting for API endpoints
6. **Caching:** Implement Redis caching for frequently accessed profiles
7. **Search:** Full-text search capabilities
8. **Export:** Profile data export functionality

---

## Contributing

When contributing to this module:

1. Follow the existing code structure
2. Add tests for new functionality
3. Update documentation
4. Ensure all tests pass
5. Follow TypeScript best practices
6. Maintain backward compatibility

---

## License

This module is part of the ChronoPay backend and follows the same license.
