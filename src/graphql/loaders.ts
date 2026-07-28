import DataLoader from 'dataloader';
import { slotService } from '../services/slotService.js';

// Mock Supplier interface and fetcher since we don't have a supplierService
export interface Supplier {
  id: string;
  name: string;
}

const mockSupplierDB = new Map<string, Supplier>([
  ['supplier-1', { id: 'supplier-1', name: 'Acme Corp' }],
  ['supplier-2', { id: 'supplier-2', name: 'Globex' }]
]);

async function fetchSuppliersByIds(ids: readonly string[]): Promise<(Supplier | Error)[]> {
  // Simulate a database batch fetch
  return ids.map(id => {
    const supplier = mockSupplierDB.get(id);
    return supplier ? supplier : new Error(`Supplier with id ${id} not found`);
  });
}

export function createLoaders() {
  return {
    slotLoader: new DataLoader(async (keys: readonly string[]) => {
      return await slotService.findByIds(keys);
    }),
    supplierLoader: new DataLoader(async (keys: readonly string[]) => {
      return await fetchSuppliersByIds(keys);
    })
  };
}
