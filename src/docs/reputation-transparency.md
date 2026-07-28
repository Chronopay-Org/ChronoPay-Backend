# Supplier Reputation Transparency Documentation

## Overview

Suppliers operating on the ChronoPay platform need visibility into the performance signals and category weights that drive their overall reputation score. Providing this transparency enables suppliers to identify operational bottlenecks and take corrective action (such as improving SLA dispatch speed or reducing buyer disputes).

To preserve buyer privacy and comply with strict data protection requirements, raw counterparty (buyer) IDs are completely redacted from signal projections, and **small-cell count suppression** is enforced for low-volume evaluation buckets.

---

## Endpoint Specification

### `GET /api/v1/suppliers/:supplierId/reputation/signals`

Retrieves an aggregated signal projection, category weights, contribution scores, actionable improvement recommendations, and privacy metadata for the specified supplier.

#### Authentication & Authorization

- **Access Level**: Owner-only or Admin
- **Header Options**:
  - `Authorization: Bearer <JWT>`
  - Or custom headers:
    - `x-supplier-owner-id: <ownerUserId>` (or `x-chronopay-user-id`)
    - `x-chronopay-role: <role>` (optional)
    - `x-tenant-id: <tenantId>` (optional tenant scoping)

#### HTTP Status Codes

- `200 OK`: Request successful; returns aggregated signal projection.
- `401 Unauthorized`: Missing or invalid authentication credentials.
- `403 Forbidden`: Authenticated user is not the registered owner of the supplier (prevents owner impersonation and cross-tenant leakage).
- `404 Not Found`: Supplier ID does not exist.
- `429 Too Many Requests`: Rate limit exceeded for the requesting principal or IP.
- `500 Internal Server Error`: Unexpected server error.

---

## Signal Categories & Weights

| Signal Category | Category Name | Default Weight | Description |
| :--- | :--- | :---: | :--- |
| `on_time_delivery` | On-Time Delivery Rate | `0.30` | Percentage of orders delivered on or before the target SLA date |
| `dispute_rate` | Dispute & Chargeback Rate | `0.25` | Frequency of buyer-initiated disputes, returns, and chargebacks |
| `fulfillment_speed` | Order Processing Speed | `0.20` | Average duration between payment confirmation and carrier dispatch |
| `buyer_ratings` | Buyer Satisfaction Rating | `0.15` | Aggregated buyer satisfaction score across completed orders |
| `cancellation_rate` | Order Cancellation Rate | `0.10` | Percentage of supplier-initiated order cancellations |

---

## Privacy Safeguards

### 1. Buyer ID Redaction
No individual buyer IDs (`buyerId`, `counterpartyId`, or transaction-level customer identifiers) are included in the API request or response payload. All metrics are aggregated at the category level.

### 2. Small-Cell Count Suppression
To prevent supplier owners from reverse-engineering individual buyer feedback or ratings from small sample sizes:
- **Threshold**: `MIN_CELL_SIZE = 5` evaluations.
- **Rule**: If the total evaluation count for a signal category is `< 5`, exact sample counts and raw category scores are masked.
- **Response Flags**:
  - `suppressed: true`
  - `totalEvaluations: null`
  - `categoryScore: null`
  - `suppressionReason: "Sample size < 5. Suppressed to protect counterparty privacy."`
  - `recommendation: "Fulfill more orders in this category (minimum 5 evaluations required) to view detailed performance metrics."`

---

## Sample Request & Response Payload

### Request
```http
GET /api/v1/suppliers/supplier-101/reputation/signals HTTP/1.1
Host: api.chronopay.com
x-supplier-owner-id: owner-alice
x-tenant-id: tenant-us-east
```

### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "supplierId": "supplier-101",
    "tenantId": "tenant-us-east",
    "overallScore": 94.2,
    "overallRatingTier": "Top Rated",
    "categoryBreakdown": [
      {
        "category": "on_time_delivery",
        "name": "On-Time Delivery Rate",
        "weight": 0.3,
        "categoryScore": 93.3,
        "contributionScore": 28,
        "totalEvaluations": 45,
        "suppressed": false,
        "status": "excellent",
        "recommendation": "Outstanding on time delivery score. Maintain current operational standards."
      },
      {
        "category": "dispute_rate",
        "name": "Dispute & Chargeback Rate",
        "weight": 0.25,
        "categoryScore": 97.8,
        "contributionScore": 24.5,
        "totalEvaluations": 45,
        "suppressed": false,
        "status": "excellent",
        "recommendation": "Outstanding dispute rate score. Maintain current operational standards."
      },
      {
        "category": "fulfillment_speed",
        "name": "Order Processing & Dispatch Speed",
        "weight": 0.2,
        "categoryScore": 90,
        "contributionScore": 18,
        "totalEvaluations": 40,
        "suppressed": false,
        "status": "excellent",
        "recommendation": "Outstanding fulfillment speed score. Maintain current operational standards."
      },
      {
        "category": "buyer_ratings",
        "name": "Buyer Satisfaction Rating",
        "weight": 0.15,
        "categoryScore": 91.7,
        "contributionScore": 13.8,
        "totalEvaluations": 12,
        "suppressed": false,
        "status": "excellent",
        "recommendation": "Outstanding buyer ratings score. Maintain current operational standards."
      },
      {
        "category": "cancellation_rate",
        "name": "Order Cancellation Rate",
        "weight": 0.1,
        "categoryScore": null,
        "contributionScore": 0,
        "totalEvaluations": null,
        "suppressed": true,
        "suppressionReason": "Sample size < 5. Suppressed to protect counterparty privacy.",
        "status": "insufficient_data",
        "recommendation": "Fulfill more orders in this category (minimum 5 evaluations required) to view detailed performance metrics."
      }
    ],
    "privacyMetadata": {
      "buyerIdsRedacted": true,
      "smallCellSuppressionActive": true,
      "minCellSizeThreshold": 5,
      "suppressedCategoryCount": 1
    },
    "generatedAt": "2026-07-28T10:35:00.000Z"
  }
}
```

---

## Prometheus Metrics

- `reputation_transparency_requests_total` (Counter, labels `tenant`, `status`): Tracks request volume by outcome (`success`, `unauthorized`, `forbidden`, `not_found`).
- `reputation_small_cell_suppressions_total` (Counter, labels `tenant`, `category`): Tracks small-cell privacy suppressions.
