// @ts-nocheck
import { EscrowDrainWorker, HoldRecord } from "../escrowDrainWorker";

describe("EscrowDrainWorker", () => {
  it("should not drain anything if no old contract hash is provided", async () => {
    const worker = new EscrowDrainWorker();
    const holds: HoldRecord[] = [{ id: "1", contractHash: "oldHash", status: "finalized" }];
    const drained = await worker.drain(holds);
    
    expect(drained).toBe(0);
    expect(holds[0].status).toBe("finalized");
  });

  it("should only drain finalized holds from the specified old contract", async () => {
    const worker = new EscrowDrainWorker({ oldContractHash: "oldHash", batchSize: 10 });
    const holds: HoldRecord[] = [
      { id: "1", contractHash: "oldHash", status: "finalized" },
      { id: "2", contractHash: "newHash", status: "finalized" },
      { id: "3", contractHash: "oldHash", status: "pending" },
    ];
    
    const drained = await worker.drain(holds);
    
    expect(drained).toBe(1);
    expect(holds[0].status).toBe("drained");
    expect(holds[1].status).toBe("finalized");
    expect(holds[2].status).toBe("pending");
  });

  it("should respect batch sizes during drain", async () => {
    const worker = new EscrowDrainWorker({ oldContractHash: "oldHash", batchSize: 2 });
    const holds: HoldRecord[] = [
      { id: "1", contractHash: "oldHash", status: "finalized" },
      { id: "2", contractHash: "oldHash", status: "finalized" },
      { id: "3", contractHash: "oldHash", status: "finalized" },
    ];
    
    const drained = await worker.drain(holds);
    
    expect(drained).toBe(2);
    expect(holds.filter(h => h.status === 'drained').length).toBe(2);
  });
});
