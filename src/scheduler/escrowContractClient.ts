/**
 * Escrow Contract Client
 * ----------------------
 *
 * Narrow interface for the escrow contract client. This intentionally sits
 * alongside `IContractClient` (which is used for general read/write contract
 * calls). The escrow listener pulls paginated event batches using its own
 * JSON-RPC `getEvents` method, which has a stable, escrow-specific shape.
 */

import type { EscrowEvent, EscrowLedgerInfo } from "./escrowEventTypes.js";

export type { EscrowLedgerInfo } from "./escrowEventTypes.js";

export interface GetEventsArgs {
  /** Ledger sequence to start the page at (inclusive). */
  startLedger: number;
  /** Maximum number of events to return. Enforced by the client. */
  limit: number;
  /**
   * Optional list of contract addresses to filter on. The Soroban RPC
   * accepts these as per-contract cursor filters; passing an empty array
   * means "no filter" on most RPC implementations.
   */
  contractAddresses?: string[];
}

export interface GetEventsResult {
  /** Page of events, in ledger order. May span multiple contracts. */
  events: EscrowEvent[];
  /**
   * Latest ledger the RPC is aware of at the time of the call. The
   * listener uses this together with `finalityDepth` to compute the
   * safe-tip ledger sequence.
   */
  latestLedgerSeq: number;
}

export interface IEscrowContractClient {
  /**
   * Fetch a single page of escrow events starting at `startLedger`. The
   * returned `latestLedgerSeq` is the network tip observed by the RPC;
   * callers should apply their own finality window.
   *
   * The implementation MUST:
   *   - Sort the returned events by `(ledgerSeq, eventIndex)` ascending.
   *   - Never silently drop events that lie within `[startLedger, max]`.
   *   - Throw on transient transport failures and let the listener retry.
   */
  getEvents(args: GetEventsArgs): Promise<GetEventsResult>;

  /**
   * Return the latest ledger known to the network. Implementations must
   * not cache longer than a few seconds.
   */
  getLatestLedger(): Promise<EscrowLedgerInfo>;
}
