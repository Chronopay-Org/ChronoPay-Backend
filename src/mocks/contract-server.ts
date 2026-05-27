import express, { Request, Response } from 'express';
import { Server } from 'node:http';

/**
 * Interface representing a mock response for a contract call.
 */
export interface ContractMock {
  contractId: string;
  method: string;
  response: any;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Interface representing a Soroban JSON-RPC request.
 */
interface SorobanRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

/**
 * Interface representing a Soroban JSON-RPC response.
 */
interface SorobanRpcResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * ContractMockServer
 * 
 * A production-grade mock server for testing interactions with Soroban contracts
 * on the Stellar network. It simulates JSON-RPC responses for common Soroban
 * operations, allowing for robust integration testing of the ChronoPay backend
 * without a real blockchain network.
 */
export class ContractMockServer {
  private app: express.Application;
  private server: Server | null = null;
  private mocks: Map<string, ContractMock> = new Map();
  private port: number;

  /**
   * Initializes the mock server.
   * @param port The port to listen on (default: 8001).
   */
  constructor(port: number = 8001) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  /**
   * Sets up the JSON-RPC routes for the mock server.
   */
  private setupRoutes() {
    this.app.post('/', (req: Request, res: Response) => {
      const body: SorobanRpcRequest = req.body;
      const { method, params, id, jsonrpc } = body;

      // Basic JSON-RPC 2.0 validation
      if (jsonrpc !== '2.0') {
        return this.sendError(res, null, -32600, 'Invalid Request');
      }

      if (id === undefined || id === null) {
        return this.sendError(res, null, -32600, 'Invalid Request: missing id');
      }

      console.log(`[ContractMockServer] Received ${method} request (id: ${id})`);

      try {
        switch (method) {
          case 'getHealth':
            return this.sendResult(res, id, { status: 'healthy' });

          case 'getNetwork':
            return this.sendResult(res, id, {
              friendbotUrl: 'https://friendbot.stellar.org/',
              passphrase: 'Test SDF Network ; September 2015',
              protocolVersion: 20
            });

          case 'getLatestLedger':
            return this.sendResult(res, id, {
              id: 'abc123ledgerhash',
              protocolVersion: 20,
              sequence: 12345
            });

          case 'simulateTransaction':
            return this.handleSimulateTransaction(body, res);

          case 'sendTransaction':
            return this.sendResult(res, id, {
              status: 'PENDING',
              hash: 'tx_' + Math.random().toString(36).substring(7),
              latestLedger: 12345,
              latestLedgerCloseTime: new Date().toISOString()
            });

          case 'getTransaction':
            return this.handleGetTransaction(body, res);

          case 'getEvents':
            return this.sendResult(res, id, {
              events: [],
              latestLedger: 12345
            });

          default:
            return this.sendError(res, id, -32601, 'Method not found');
        }
      } catch (error: any) {
        console.error(`[ContractMockServer] Error processing ${method}:`, error);
        return this.sendError(res, id, -32603, 'Internal error');
      }
    });

    // Health check endpoint for the mock server itself
    this.app.get('/_health', (_req: Request, res: Response) => {
      res.json({ status: 'mock-server-ok' });
    });
  }

  /**
   * Handles simulateTransaction RPC calls.
   * Matches mocks based on contractId and method if provided in the params.
   */
  private handleSimulateTransaction(req: SorobanRpcRequest, res: Response) {
    const mockKey = this.findMockKey(req.params);
    const mock = this.mocks.get(mockKey);

    if (mock) {
      if (mock.error) {
        return this.sendError(res, req.id, mock.error.code, mock.error.message);
      }
      return this.sendResult(res, req.id, {
        results: [{ xdr: mock.response }],
        latestLedger: 12345,
        cost: { cpuInsns: '1000', memBytes: '1000' },
        events: []
      });
    }

    // Default simulation result
    return this.sendResult(res, req.id, {
      results: [{ xdr: 'AAAAAgAAAAEAAAA=' }],
      latestLedger: 12345,
      cost: { cpuInsns: '100', memBytes: '100' }
    });
  }

  /**
   * Handles getTransaction RPC calls.
   */
  private handleGetTransaction(req: SorobanRpcRequest, res: Response) {
    return this.sendResult(res, req.id, {
      status: 'SUCCESS',
      latestLedger: 12346,
      latestLedgerCloseTime: new Date().toISOString(),
      oldestLedger: 12000,
      oldestLedgerCloseTime: new Date().toISOString(),
      resultMetaXdr: 'AAAAAgAAAAEAAAA=',
      resultXdr: 'AAAAAgAAAAEAAAA='
    });
  }

  /**
   * Finds a mock key based on request parameters.
   */
  private findMockKey(params: any): string {
    if (!params) return 'default';

    // Allow tests to specify a mock key directly in the request for easy matching
    if (params.mockKey) return params.mockKey;

    // If contractId and method are provided directly in params (non-standard but useful for testing)
    if (params.contractId && params.method) {
      return `${params.contractId}:${params.method}`;
    }

    return 'default';
  }

  /**
   * Sends a successful JSON-RPC response.
   */
  private sendResult(res: Response, id: string | number, result: any) {
    const response: SorobanRpcResponse = {
      jsonrpc: '2.0',
      id,
      result
    };
    res.json(response);
  }

  /**
   * Sends an error JSON-RPC response.
   */
  private sendError(res: Response, id: string | number | null, code: number, message: string) {
    const response: SorobanRpcResponse = {
      jsonrpc: '2.0',
      id: id || 0,
      error: { code, message }
    };
    res.status(code === -32603 ? 500 : 200).json(response);
  }

  /**
   * Adds a mock response for a specific contract call.
   * @param mock The mock configuration.
   */
  public addMock(mock: ContractMock) {
    const key = `${mock.contractId}:${mock.method}`;
    this.mocks.set(key, mock);
    console.log(`[ContractMockServer] Added mock for ${key}`);
  }

  /**
   * Starts the mock server.
   */
  public async start(): Promise<void> {
    if (this.server) return;

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[ContractMockServer] Started on http://localhost:${this.port}`);
        resolve();
      });

      this.server.on('error', (err: Error) => {
        console.error('[ContractMockServer] Failed to start:', err);
        reject(err);
      });
    });
  }

  /**
   * Stops the mock server.
   */
  public async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log('[ContractMockServer] Stopped');
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Clears all registered mocks.
   */
  public clearMocks() {
    this.mocks.clear();
  }
}
