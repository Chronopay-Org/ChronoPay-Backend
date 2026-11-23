# Escrow Contract Upgrade Runbook

## Migration Path
1. Set `ESCROW_PAUSED=true` or use the admin API (`POST /api/v1/admin/escrow/pause`) to pause new holds.
2. Deploy the new contract to the network and retrieve its hash.
3. Update `ESCROW_CONTRACT_HASH` environment variable with the new hash.
4. Restart the application to enforce startup validation on the new pin.
5. Unpause the escrow system via the admin API (`POST /api/v1/admin/escrow/pause` with `paused: false`).
6. The background `EscrowDrainWorker` will automatically drain any lingering finalized holds on the old contract.

## Rollback Plan
If the new contract exhibits critical bugs or fails validation during startup:
1. Revert `ESCROW_CONTRACT_HASH` to the previous contract hash.
2. Set `ESCROW_PAUSED=true`.
3. Restart the application.
4. Unpause the escrow system. The drain worker will naturally stop trying to drain from the active contract once traffic resumes on the old pin.
5. Investigate the failure before attempting the migration again.

## Edge Cases
- **Paused-mid-request:** If a request begins before the pause flag is read but attempts to reserve a slot after the flag is enabled, it will throw `EscrowPausedError` and the request will cleanly fail.
- **Hash mismatch on boot:** The application validates the format of `ESCROW_CONTRACT_HASH` on startup. If the format is invalid, it throws a fatal error and prevents boot.
- **Drain crash recovery:** The drain worker processes finalized holds idempotently. If it crashes mid-drain, it will simply resume from the pending holds on the next tick without double-draining.
