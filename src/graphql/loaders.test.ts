import { createLoaders } from './loaders.js';
import { slotService } from '../services/slotService.js';

describe('createLoaders', () => {
  beforeEach(() => {
    slotService.reset();
  });

  describe('supplierLoader', () => {
    it('should successfully load existing suppliers', async () => {
      const { supplierLoader } = createLoaders();
      const supplier1 = await supplierLoader.load('supplier-1');
      expect(supplier1).toEqual({ id: 'supplier-1', name: 'Acme Corp' });
      
      const supplier2 = await supplierLoader.load('supplier-2');
      expect(supplier2).toEqual({ id: 'supplier-2', name: 'Globex' });
    });

    it('should return an Error for a non-existing supplier', async () => {
      const { supplierLoader } = createLoaders();
      await expect(supplierLoader.load('invalid-id')).rejects.toThrow('Supplier with id invalid-id not found');
    });

    it('should batch multiple supplier requests correctly', async () => {
      const { supplierLoader } = createLoaders();
      const results = await supplierLoader.loadMany(['supplier-1', 'invalid-id', 'supplier-2']);
      
      expect(results[0]).toEqual({ id: 'supplier-1', name: 'Acme Corp' });
      expect(results[1]).toBeInstanceOf(Error);
      expect((results[1] as Error).message).toBe('Supplier with id invalid-id not found');
      expect(results[2]).toEqual({ id: 'supplier-2', name: 'Globex' });
    });
  });

  describe('slotLoader', () => {
    it('should load an existing slot', async () => {
      const slot = slotService.createSlot({ professional: 'Pro', startTime: 100, endTime: 200 });
      const { slotLoader } = createLoaders();
      
      const loadedSlot = await slotLoader.load(String(slot.id));
      expect(loadedSlot).toEqual(slot);
    });

    it('should return an Error for a non-existing slot', async () => {
      const { slotLoader } = createLoaders();
      await expect(slotLoader.load('99999')).rejects.toThrow('Slot with ID 99999 not found');
    });
    
    it('should batch multiple slot requests', async () => {
      const slot1 = slotService.createSlot({ professional: 'Pro 1', startTime: 100, endTime: 200 });
      const slot2 = slotService.createSlot({ professional: 'Pro 2', startTime: 200, endTime: 300 });
      const { slotLoader } = createLoaders();
      
      const results = await slotLoader.loadMany([String(slot1.id), '99999', String(slot2.id)]);
      expect(results[0]).toEqual(slot1);
      expect(results[1]).toBeInstanceOf(Error);
      expect(results[2]).toEqual(slot2);
    });
  });
});
