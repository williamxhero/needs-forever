import {
  acquireRecoveryOwner,
  armRecovery,
  cancelRecovery,
  createRecoveryPlan,
  extendRecoveryWindowForActiveWriter,
  interruptRecovery,
  markRecoveryRunning,
  reconcileRecoveryTick,
  reconcileStaleOwner,
  recoveryCurrent,
  resetRecoveryWindow,
  waitForNativeReceipt,
  type RecoveryCancellation,
  type RecoveryReason,
} from './recovery-coordinator.js';

/**
 * A-bound recovery policy seam. Adapters may persist or schedule these
 * actions, but generation rotation, cancellation, receipt waiting and owner
 * reconciliation stay behind this one module.
 */
export const RecoveryEpisode = {
  arm: armRecovery,
  cancel: cancelRecovery,
  createPlan: createRecoveryPlan,
  waitForNativeReceipt,
  markRunning: markRecoveryRunning,
  reconcileOwner: reconcileStaleOwner,
  reconcileTick: reconcileRecoveryTick,
  current: recoveryCurrent,
  resetWindow: resetRecoveryWindow,
  interrupt: interruptRecovery,
  extendForActiveWriter: extendRecoveryWindowForActiveWriter,
  acquireOwner: acquireRecoveryOwner,
} as const;

export type { RecoveryCancellation, RecoveryReason };
export {
  acquireRecoveryOwner,
  armRecovery,
  cancelRecovery,
  createRecoveryPlan,
  extendRecoveryWindowForActiveWriter,
  interruptRecovery,
  markRecoveryRunning,
  reconcileRecoveryTick,
  reconcileStaleOwner,
  recoveryCurrent,
  resetRecoveryWindow,
  waitForNativeReceipt,
};
