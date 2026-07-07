/**
 * QuorixASP reference / hackathon demo modules.
 *
 * NOT used in the live OKX.AI marketplace path. Kept for competency demos and
 * local testing against TaskManager 0x599e…E01D. Disable in production via
 * REFERENCE_DEMO_ENABLED=false (default when NODE_ENV=production).
 */
export { ReferenceOnChainMarketplaceScanner } from './marketplaceReference';
export {
  runReferenceTaskManagerEscrowPath,
  type ReferenceEscrowHandlers,
} from './taskManagerEscrowPath';