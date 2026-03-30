import request from 'supertest';
import { ContractMockServer } from '../../mocks/contract-server.js';

describe('ContractMockServer', () => {
  let mockServer: ContractMockServer;
  const PORT = 8002; // Use a different port to avoid conflicts

  beforeAll(async () => {
    mockServer = new ContractMockServer(PORT);
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.clearMocks();
  });

  it('GET /_health returns 200 and status ok', async () => {
    const res = await request(`http://localhost:${PORT}`).get('/_health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('mock-server-ok');
  });

  it('POST / getHealth returns healthy status', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('healthy');
    expect(res.body.id).toBe(1);
  });

  it('POST / getNetwork returns network details', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 'req_1',
        method: 'getNetwork'
      });

    expect(res.status).toBe(200);
    expect(res.body.result.passphrase).toBeDefined();
    expect(res.body.id).toBe('req_1');
  });

  it('POST / simulateTransaction returns default simulation', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 100,
        method: 'simulateTransaction',
        params: { transaction: 'AAAA...' }
      });

    expect(res.status).toBe(200);
    expect(res.body.result.results).toBeDefined();
    expect(res.body.result.results[0].xdr).toBe('AAAAAgAAAAEAAAA=');
    expect(res.body.result.cost).toBeDefined();
  });

  it('POST / simulateTransaction returns registered mock result', async () => {
    const contractId = 'C123';
    const method = 'test_method';
    const mockResponse = 'MOCK_XDR_DATA';

    mockServer.addMock({
      contractId,
      method,
      response: mockResponse
    });

    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 101,
        method: 'simulateTransaction',
        params: { contractId, method }
      });

    expect(res.status).toBe(200);
    expect(res.body.result.results[0].xdr).toBe(mockResponse);
  });

  it('POST / simulateTransaction returns error from mock', async () => {
    const contractId = 'C123';
    const method = 'fail_method';

    mockServer.addMock({
      contractId,
      method,
      response: null,
      error: { code: -32001, message: 'Custom Contract Error' }
    });

    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 102,
        method: 'simulateTransaction',
        params: { contractId, method }
      });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32001);
    expect(res.body.error.message).toBe('Custom Contract Error');
  });

  it('POST / simulateTransaction returns result using mockKey hint', async () => {
    const mockKey = 'special-scenario';
    const mockResponse = 'SPECIAL_DATA';

    // Directly adding to mocks map for testing the hint logic
    (mockServer as any).mocks.set(mockKey, {
      contractId: 'any',
      method: 'any',
      response: mockResponse
    });

    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 103,
        method: 'simulateTransaction',
        params: { mockKey }
      });

    expect(res.status).toBe(200);
    expect(res.body.result.results[0].xdr).toBe(mockResponse);
  });

  it('POST / sendTransaction returns a transaction hash', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 200,
        method: 'sendTransaction',
        params: { transaction: 'AAAA...' }
      });

    expect(res.status).toBe(200);
    expect(res.body.result.hash).toMatch(/^tx_/);
    expect(res.body.result.status).toBe('PENDING');
  });

  it('POST / getTransaction returns transaction success result', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 300,
        method: 'getTransaction',
        params: { hash: 'tx_abc' }
      });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('SUCCESS');
  });

  it('POST / getEvents returns empty events by default', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 400,
        method: 'getEvents',
        params: { startLedger: 12345 }
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result.events)).toBe(true);
  });

  it('POST / with invalid jsonrpc version returns error', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '1.0',
        id: 1,
        method: 'getHealth'
      });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32600);
    expect(res.body.error.message).toBe('Invalid Request');
  });

  it('POST / with missing id returns error', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        method: 'getHealth'
      });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32600);
    expect(res.body.error.message).toContain('missing id');
  });

  it('POST / with unknown method returns error', async () => {
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'unknownMethod'
      });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
    expect(res.body.error.message).toBe('Method not found');
  });

  it('POST / handles errors gracefully during processing', async () => {
    // We can simulate an internal error by sending something unexpected or mocking internal methods
    // For this simple test, we'll just check if it responds to an empty body
    const res = await request(`http://localhost:${PORT}`)
      .post('/')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
  });
});
