/**
 * Factory for creating mock slot objects.
 * @param overrides - Partial slot object to override defaults.
 * @returns A mock slot object.
 */
export const createSlot = (overrides: any = {}) => {
  return {
    id: Math.floor(Math.random() * 1000),
    professional: "test-pro",
    startTime: Date.now(),
    endTime: Date.now() + 3600000,
    ...overrides,
  };
};
