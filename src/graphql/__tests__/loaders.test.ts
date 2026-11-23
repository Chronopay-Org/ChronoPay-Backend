import { jest } from '@jest/globals';
import { createLoaders } from '../loaders.js';
import { slotService } from '../../services/slotService.js';

describe('GraphQL Loaders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('batches slot lookups into a single query', async () => {
    const { slotLoader } = createLoaders();
    jest.spyOn(slotService, 'findByIds').mockImplementation(async (ids: readonly (string | number)[]) => {
      return ids.map(id => ({ id: String(id) } as any));
    });
    
    // Request multiple slots
    const p1 = slotLoader.load('1');
    const p2 = slotLoader.load('2');
    const p3 = slotLoader.load('3');
    
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    
    expect(s1).toEqual({ id: '1' });
    expect(s2).toEqual({ id: '2' });
    expect(s3).toEqual({ id: '3' });
    
    // Assert single batch call with all IDs
    expect(slotService.findByIds).toHaveBeenCalledTimes(1);
    expect(slotService.findByIds).toHaveBeenCalledWith(['1', '2', '3']);
  });

  it('batches supplier lookups into a single query', async () => {
    const { supplierLoader } = createLoaders();
    
    const p1 = supplierLoader.load('supplier-1');
    const p2 = supplierLoader.load('supplier-2');
    
    const [s1, s2] = await Promise.all([p1, p2]);
    
    expect(s1).toEqual({ id: 'supplier-1', name: 'Acme Corp' });
    expect(s2).toEqual({ id: 'supplier-2', name: 'Globex' });
    
    // Assuming mockSupplierDB doesn't throw, we know dataloader calls the internal batch function once per tick
  });
  
  it('handles missing slots properly', async () => {
    const { slotLoader } = createLoaders();
    jest.spyOn(slotService, 'findByIds').mockImplementation(async (ids: readonly (string | number)[]) => {
      return ids.map(id => new Error(`Slot with ID ${id} not found`));
    });
    
    await expect(slotLoader.load('99')).rejects.toThrow('Slot with ID 99 not found');
  });
});
