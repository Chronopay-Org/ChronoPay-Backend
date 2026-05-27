# Contract Mock Server

The `ContractMockServer` is a production-grade utility designed for testing the ChronoPay backend by simulating responses from the Soroban RPC server. It allows for comprehensive integration testing without the need for a live Stellar/Soroban network.

## Features

- **JSON-RPC 2.0 Compliant**: Supports standard Soroban RPC methods such as `getHealth`, `getNetwork`, `getLatestLedger`, `simulateTransaction`, `sendTransaction`, and `getTransaction`.
- **Customizable Mocks**: Allows registering specific responses for contract calls based on `contractId` and `method`.
- **Failure Mode Testing**: Supports mocking error responses to test the backend's error handling logic.
- **Secure by Default**: Restricted to local testing environments and designed to be lightweight.

## Getting Started

### Installation

Ensure all dependencies are installed:

```bash
npm install
```

### Usage in Tests

```typescript
import { ContractMockServer } from '../mocks/contract-server';

describe('MyService', () => {
  let mockServer: ContractMockServer;

  beforeAll(async () => {
    mockServer = new ContractMockServer(8001);
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('should handle contract simulation', async () => {
    mockServer.addMock({
      contractId: 'C123...',
      method: 'tokenize_slot',
      response: 'AAAA...' // Base64 XDR result
    });

    // Your backend code that calls the mock server
  });
});
```

## Supported Methods

| Method | Description |
|--------|-------------|
| `getHealth` | Returns the health status of the mock server. |
| `getNetwork` | Returns network details (passphrase, protocol version). |
| `simulateTransaction` | Returns simulated results for a transaction. Matches registered mocks if possible. |
| `sendTransaction` | Simulates transaction submission and returns a hash. |
| `getTransaction` | Simulates transaction status retrieval. |

## Implementation Details

The server is built using Express and follows the standard JSON-RPC 2.0 protocol. It includes robust error handling and logging to facilitate debugging.

### Security Notes

- The mock server is intended for **local testing only**.
- Do not expose this server to the public internet.
- For production-grade security, ensure that any sensitive data in mocks is properly sanitized.

### Assumptions and Constraints

- **XDR Decoding**: Currently, the server uses simple key matching for mocks. In future versions, full XDR decoding can be added to match specific arguments within a transaction.
- **Ledger Sequence**: The server uses a static ledger sequence (12345) by default, which is sufficient for most integration tests.
