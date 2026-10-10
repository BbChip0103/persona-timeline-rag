/** Redis target guard/connection boundary, retained without BullMQ import side effects.
 * Fleet registries and gateway discovery were retired in the framework migration.
 */
export * from './local-guard.js';
export * from './redis.js';
