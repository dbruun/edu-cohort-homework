'use strict';

// The import record is shared with the portal API and, later, the indexing
// function. Every write is a merge so that concurrent stages cannot erase each
// other's fields.
class ImportState {
  constructor(tableClient, partitionKey, importId) {
    this.table = tableClient;
    this.partitionKey = partitionKey;
    this.importId = importId;
  }

  async read() {
    return this.table.getEntity(this.partitionKey, this.importId);
  }

  async merge(patch) {
    await this.table.updateEntity({
      partitionKey: this.partitionKey,
      rowKey: this.importId,
      updatedAt: new Date(),
      ...patch
    }, 'Merge');
  }

  // Cancellation is cooperative: the portal records the request and the worker
  // stops at its next member boundary.
  async isCancelled() {
    try {
      const entity = await this.read();
      return entity.cancellationRequested === true || entity.status === 'cancelled';
    } catch {
      // A transient table failure must not abort work that is otherwise fine.
      return false;
    }
  }

    // Extraction asks once per member, which on a large archive would be
    // thousands of reads, so the answer is cached briefly. The same beat is
    // what tells the watchdog this worker is still alive: without it a long
    // extraction is indistinguishable from a container that was evicted.
    cancellationChecker(intervalMs = 10000, heartbeatMs = 60000) {
      let checkedAt = 0;
      let beatAt = Date.now();
      let cancelled = false;
      return async () => {
        const now = Date.now();
        if (cancelled || now - checkedAt < intervalMs) return cancelled;
        checkedAt = now;
        cancelled = await this.isCancelled();
        if (!cancelled && now - beatAt >= heartbeatMs) {
          beatAt = now;
          // A missed heartbeat only costs a wider watchdog window, so it must
          // never interrupt extraction that is otherwise healthy.
          await this.merge({ heartbeatAt: new Date() }).catch(() => {});
        }
        return cancelled;
      };
    }
}

// Extraction is only allowed to advance an import that is genuinely waiting for
// it, which is what makes a duplicate blob event or a job retry harmless.
const EXTRACTABLE_STATUSES = new Set(['uploaded', 'queued', 'extracting']);

function canExtract(entity) {
  return EXTRACTABLE_STATUSES.has(entity?.status);
}

module.exports = { EXTRACTABLE_STATUSES, ImportState, canExtract };
