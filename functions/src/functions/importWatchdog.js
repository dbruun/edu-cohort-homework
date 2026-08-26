'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { classifyImport, timeoutsFromEnv, watchedStatusFilter } = require('../watchdog');
const { extractionJobConfig, startExtractionJob } = require('../jobs');

// One sweep must never turn into an unbounded job storm, so a single run only
// ever acts on this many records and the next tick picks up the rest.
const DEFAULT_SWEEP_LIMIT = 100;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

let cachedTable;
function importTable() {
  if (!cachedTable) {
    cachedTable = new TableClient(
      `https://${required('STORAGE_ACCOUNT')}.table.core.windows.net`,
      process.env.IMSCC_IMPORT_TABLE || 'ImsccImports',
      new DefaultAzureCredential()
    );
  }
  return cachedTable;
}

function sweepLimit() {
  const limit = Number(process.env.WATCHDOG_SWEEP_LIMIT);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SWEEP_LIMIT;
}

async function failImport(table, entity, decision, context) {
  await table.updateEntity({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    status: decision.status,
    error: decision.message,
    watchdogReason: decision.reason,
    updatedAt: new Date()
  }, 'Merge');
  context.warn(`[watchdog] Import ${entity.rowKey} failed as '${decision.status}': ${decision.reason}.`);
}

async function retryImport(table, entity, decision, context) {
  // The attempt is recorded before the job starts, so a watchdog run that dies
  // mid-sweep cannot hand out an unlimited number of free retries.
  await table.updateEntity({
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    status: 'queued',
    extractionAttempts: decision.attempt,
    watchdogReason: decision.reason,
    updatedAt: new Date()
  }, 'Merge');

  await startExtractionJob(
    extractionJobConfig(),
    { importId: entity.rowKey, partitionKey: entity.partitionKey }
  );

  context.warn(`[watchdog] Restarted import ${entity.rowKey} (attempt ${decision.attempt}): ${decision.reason}.`);
}

async function sweepStuckImports(timer, context) {
  const table = importTable();
  const options = { now: Date.now(), timeouts: timeoutsFromEnv() };
  const limit = sweepLimit();
  const summary = { inspected: 0, retried: 0, failed: 0, errors: 0 };

  const entities = table.listEntities({ queryOptions: { filter: watchedStatusFilter() } });
  for await (const entity of entities) {
    if (summary.inspected >= limit) {
      context.warn(`[watchdog] Reached the sweep limit of ${limit}; the remainder waits for the next run.`);
      break;
    }
    summary.inspected += 1;

    const decision = classifyImport(entity, options);
    if (decision.action === 'ignore') continue;

    // One import that cannot be recovered must not stop the sweep from
    // recovering the others, so each decision is isolated.
    try {
      if (decision.action === 'fail') {
        await failImport(table, entity, decision, context);
        summary.failed += 1;
      } else if (decision.action === 'retry') {
        await retryImport(table, entity, decision, context);
        summary.retried += 1;
      }
    } catch (error) {
      summary.errors += 1;
      context.error(`[watchdog] Could not ${decision.action} import ${entity.rowKey}.`, error);
    }
  }

  context.log(
    `[watchdog] Inspected ${summary.inspected} import(s): ${summary.retried} retried, ` +
    `${summary.failed} failed, ${summary.errors} error(s).`
  );
  return summary;
}

app.timer('sweepStuckImports', {
  schedule: '0 */5 * * * *',
  handler: sweepStuckImports
});

module.exports = { DEFAULT_SWEEP_LIMIT, sweepStuckImports };
