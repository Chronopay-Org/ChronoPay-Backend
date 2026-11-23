export class EscrowMigrationState {
  private paused: boolean = false;
  private pinnedHash: string | undefined;

  constructor() {
    this.pinnedHash = process.env.ESCROW_CONTRACT_HASH;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  getPinnedHash(): string | undefined {
    return this.pinnedHash;
  }
}

export const escrowMigrationState = new EscrowMigrationState();
