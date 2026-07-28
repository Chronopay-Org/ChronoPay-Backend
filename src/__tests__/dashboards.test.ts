import { jest } from '@jest/globals';
import { validateDashboards } from '../../scripts/validate-dashboards.js';
import { uploadDashboards } from '../../scripts/upload-dashboards.js';
import fs from 'fs';
import path from 'path';

global.fetch = jest.fn() as jest.Mock;

describe('Dashboards as Code', () => {
  let readFileSyncSpy: jest.SpiedFunction<typeof fs.readFileSync>;
  let readdirSyncSpy: jest.SpiedFunction<typeof fs.readdirSync>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
    readdirSyncSpy = jest.spyOn(fs, 'readdirSync');
    
    // Mock the config file reading
    readFileSyncSpy.mockImplementation((filePath: any, encoding?: any): any => {
      const normalizedPath = filePath.toString().replace(/\\/g, '/');
      if (normalizedPath.endsWith('ops/grafana-config.json')) {
        return JSON.stringify({
          version: '10.4.0',
          url: 'http://localhost:3000',
          dashboardFolder: 'ops/dashboards'
        });
      }
      
      // Default valid dashboard
      if (normalizedPath.includes('ops/dashboards/test-dash.json')) {
        return JSON.stringify({
          uid: 'test-dash',
          title: 'Test Dashboard',
          version: 1,
          panels: [
            { id: 1, type: 'stat', title: 'Panel 1' }
          ]
        });
      }
      
      // Dashboard with panel type removed (invalid if type is missing)
      if (normalizedPath.includes('ops/dashboards/invalid-panel.json')) {
        return JSON.stringify({
          uid: 'invalid-panel',
          title: 'Invalid Panel Dashboard',
          version: 2,
          panels: [
            { id: 1, title: 'Panel 1' } // Missing type
          ]
        });
      }

      // Dashboard with version bump
      if (normalizedPath.includes('ops/dashboards/version-bump.json')) {
        return JSON.stringify({
          uid: 'test-dash',
          title: 'Test Dashboard',
          version: 2,
          panels: [
            { id: 1, type: 'stat', title: 'Panel 1' }
          ]
        });
      }
      
      // Dashboard renamed (uid or title change)
      if (normalizedPath.includes('ops/dashboards/renamed-dash.json')) {
        return JSON.stringify({
          uid: 'test-dash-renamed',
          title: 'Test Dashboard Renamed',
          version: 1,
          panels: [
            { id: 1, type: 'stat', title: 'Panel 1' }
          ]
        });
      }

      return '{}';
    });

    readdirSyncSpy.mockImplementation((dirPath: any): any => {
      const normalizedPath = dirPath.toString().replace(/\\/g, '/');
      if (normalizedPath.endsWith('ops/dashboards')) {
        return ['test-dash.json'] as any;
      }
      return [] as any;
    });
  });

  describe('validateDashboards', () => {
    it('should validate a correct dashboard schema', async () => {
      let err = null;
      try {
        await validateDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
    });

    it('should throw error on missing panel type (panel type removal)', async () => {
      readdirSyncSpy.mockReturnValue(['invalid-panel.json'] as any);
      let err: any = null;
      try {
        await validateDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err.message).toBe('One or more dashboards failed schema validation.');
    });

    it('should validate successfully on version bump', async () => {
      readdirSyncSpy.mockReturnValue(['version-bump.json'] as any);
      let err = null;
      try {
        await validateDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
    });

    it('should validate successfully on dashboard rename', async () => {
      readdirSyncSpy.mockReturnValue(['renamed-dash.json'] as any);
      let err = null;
      try {
        await validateDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
    });
  });

  describe('uploadDashboards', () => {
    it('should upload dashboard to Grafana API successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, uid: 'test-dash', status: 'success', version: 1 })
      });

      let err = null;
      try {
        await uploadDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/dashboards/db',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should include API key if provided', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, uid: 'test-dash', status: 'success', version: 1 })
      });

      let err = null;
      try {
        await uploadDashboards('http://localhost:3000', 'my-api-key');
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/dashboards/db',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-api-key'
          })
        })
      );
    });

    it('should throw an error if upload fails', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid payload'
      });

      let err: any = null;
      try {
        await uploadDashboards();
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err.message).toBe('Failed to upload test-dash.json: 400 Bad Request - Invalid payload');
    });
  });
});
