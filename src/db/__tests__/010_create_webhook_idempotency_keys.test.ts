import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { migration } from '../migrations/010_create_webhook_idempotency_keys.js';
import { PoolClient } from 'pg';

describe('010_create_webhook_idempotency_keys migration', () => {
  let mockClient: Partial<PoolClient>;
  let mockQuery: jest.Mock<any>;

  beforeEach(() => {
    mockQuery = jest.fn<any>().mockResolvedValue({ rowCount: 0, rows: [] } as never);
    mockClient = {
      query: mockQuery as unknown as PoolClient['query'],
    };
  });

  describe('contract and metadata', () => {
    it('exposes the expected migration metadata', () => {
      expect(migration).toBeDefined();
      expect(migration.id).toBe('012');
      expect(migration.name).toBe('create_webhook_idempotency_keys');
      expect(typeof migration.up).toBe('function');
      expect(typeof migration.down).toBe('function');
    });
  });

  describe('up migration', () => {
    it('executes create table and index queries on valid client', async () => {
      await migration.up(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(2);

      const createTableQuery = mockQuery.mock.calls[0][0] as string;
      expect(createTableQuery).toContain('CREATE TABLE IF NOT EXISTS webhook_idempotency_keys');
      expect(createTableQuery).toContain('tenant_id VARCHAR(255) NOT NULL');
      expect(createTableQuery).toContain('idempotency_key VARCHAR(255) NOT NULL');
      expect(createTableQuery).toContain('response_body JSONB');
      expect(createTableQuery).toContain('created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
      expect(createTableQuery).toContain('expires_at TIMESTAMP WITH TIME ZONE NOT NULL');
      expect(createTableQuery).toContain('PRIMARY KEY (tenant_id, idempotency_key)');

      const createIndexQuery = mockQuery.mock.calls[1][0] as string;
      expect(createIndexQuery).toContain('CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_keys_expires_at');
      expect(createIndexQuery).toContain('ON webhook_idempotency_keys(expires_at)');
    });

    it('propagates database errors when table creation query fails', async () => {
      const dbError = new Error('DB connection failed');
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow('DB connection failed');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('propagates database errors when index creation query fails', async () => {
      const dbError = new Error('Index creation failed');
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow('Index creation failed');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('throws TypeError when client or query method is missing', async () => {
      await expect(migration.up(null as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.up({} as PoolClient)).rejects.toThrow();
    });
  });

  describe('down migration', () => {
    it('executes drop table query on valid client', async () => {
      await migration.down(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const dropQuery = mockQuery.mock.calls[0][0] as string;
      expect(dropQuery).toContain('DROP TABLE IF EXISTS webhook_idempotency_keys');
    });

    it('propagates database errors when drop table query fails', async () => {
      const dbError = new Error('Drop table failed');
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow('Drop table failed');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('throws TypeError when client or query method is missing', async () => {
      await expect(migration.down(null as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.down({} as PoolClient)).rejects.toThrow();
    });
  });
});