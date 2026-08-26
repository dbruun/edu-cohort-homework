'use strict';

// Every stage of an import is advanced by something that can disappear without
// leaving a note: a browser tab, a queue delivery, or a container that is
// evicted mid-extraction. Nothing else in the pipeline can observe an absence,
// so the watchdog decides purely from the stored record and the clock, and the
// decision is kept pure here so every rule can be tested without Azure.

const MINUTE = 60 * 1000;

// Anything outside this set is either terminal or unknown, and the watchdog
// leaves it alone. Listing what is watched rather than what is finished means a
// status added later is ignored by default instead of being failed by mistake.
const WATCHED_STATUSES = new Set(['uploading', 'uploaded', 'queued', 'extracting', 'indexing']);

const DEFAULT_TIMEOUTS = {
  // The upload SAS cannot be renewed, so once it expires the browser can never
  // finish. The grace period covers clock skew and the final block commit.
  uploadGraceMs: 15 * MINUTE,
  // Used only when a record predates the stored expiry.
  uploadWindowMs: 240 * MINUTE,
  // 'uploaded' is waiting on an Event Grid delivery and nothing else.
  uploadedMs: 15 * MINUTE,
  // 'queued' is waiting on the job scheduler admitting a container.
  queuedMs: 20 * MINUTE,
  // 'extracting' has to cover the archive download, which produces no
  // heartbeat, before the worker starts beating roughly once a minute.
  extractingMs: 60 * MINUTE,
  // A cancelled import still needs a worker to write the terminal state, so the
  // watchdog waits long enough for a live worker to reach its next checkpoint.
  cancellationMs: 15 * MINUTE,
  // Indexing checkpoints as it goes, so a record that stops moving really is
  // stuck. The sweep stays off unless a timeout is configured, so a deployment
  // that has no indexing stage can never fail a successful extraction; the
  // Bicep template turns it on.
  indexingMs: 0
};

const DEFAULT_MAX_ATTEMPTS = 3;

const RETRY_TIMEOUT_KEYS = {
  uploaded: 'uploadedMs',
  queued: 'queuedMs',
  extracting: 'extractingMs',
  indexing: 'indexingMs'
};

function toTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function latest(...values) {
  const times = values.map(toTime).filter((time) => time !== null);
  return times.length ? Math.max(...times) : null;
}

function ignore(reason) {
  return { action: 'ignore', reason };
}

function fail(status, reason, message) {
  return { action: 'fail', status, reason, message };
}

// The professor sees `message`; `reason` is for telemetry and stays internal.
function attemptsOf(entity) {
  const attempts = Number(entity.extractionAttempts);
  return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
}

// A heartbeat proves a worker is alive. Falling back to updatedAt only proves a
// stage transition happened, which is still better than assuming the worst.
function lastProgressAt(entity) {
  return latest(entity.heartbeatAt, entity.updatedAt, entity.createdAt);
}

function uploadDeadline(entity, limits) {
  const expiry = toTime(entity.expiresAt);
  if (expiry !== null) return expiry;
  const created = toTime(entity.createdAt);
  return created === null ? null : created + limits.uploadWindowMs;
}

function classifyImport(entity, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const limits = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
  const maxAttempts = options.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : options.maxAttempts;
  const status = entity && entity.status;

  if (!WATCHED_STATUSES.has(status)) return ignore(`status '${status}' is not watched`);

  const progressedAt = lastProgressAt(entity);
  // Without a single usable timestamp there is no evidence of being stuck, and
  // guessing would fail healthy imports.
  if (progressedAt === null) return ignore('the record has no usable timestamp');
  const idleMs = now - progressedAt;

  if (entity.cancellationRequested === true) {
    if (idleMs < limits.cancellationMs) return ignore('a worker may still be stopping');
    return fail('cancelled', `cancelled and idle for ${idleMs}ms`, 'This import was cancelled.');
  }

  if (status === 'uploading') {
    const deadline = uploadDeadline(entity, limits);
    if (deadline === null) return ignore('the upload window cannot be determined');
    if (now < deadline + limits.uploadGraceMs) return ignore('the upload window is still open');
    return fail(
      'upload-expired',
      `the upload window closed ${now - deadline}ms ago`,
      'The upload did not finish before its access window closed. Start the import again.'
    );
  }

  const timeoutMs = limits[RETRY_TIMEOUT_KEYS[status]];
  if (!timeoutMs || timeoutMs <= 0) return ignore(`sweeping '${status}' is disabled`);
  if (idleMs < timeoutMs) return ignore(`'${status}' has been idle for only ${idleMs}ms`);

  // Nothing restarts indexing yet, so a stalled index is reported rather than
  // retried into a loop. The retry path starts the extraction job, which would
  // be the wrong work for an import that is already past extraction.
  if (status === 'indexing') {
    return fail(
      'failed-processing',
      `indexing stalled for ${idleMs}ms`,
      'The course could not be prepared for search. Try the import again.'
    );
  }

  const attempts = attemptsOf(entity);
  if (attempts >= maxAttempts) {
    return fail(
      'failed-processing',
      `'${status}' stalled for ${idleMs}ms after ${attempts} attempt(s)`,
      'The course export could not be processed. Try the import again.'
    );
  }

  return {
    action: 'retry',
    attempt: attempts + 1,
    reason: `'${status}' stalled for ${idleMs}ms after ${attempts} attempt(s)`
  };
}

function minutesFrom(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * MINUTE : null;
}

// Operations needs to widen a window without a redeploy, so every threshold is
// overridable, and an unparseable value falls back to the default instead of
// silently disabling a sweep.
function timeoutsFromEnv(env = process.env) {
  const overrides = {
    uploadGraceMs: minutesFrom(env, 'WATCHDOG_UPLOAD_GRACE_MINUTES'),
    uploadedMs: minutesFrom(env, 'WATCHDOG_UPLOADED_MINUTES'),
    queuedMs: minutesFrom(env, 'WATCHDOG_QUEUED_MINUTES'),
    extractingMs: minutesFrom(env, 'WATCHDOG_EXTRACTING_MINUTES'),
    cancellationMs: minutesFrom(env, 'WATCHDOG_CANCELLATION_MINUTES'),
    indexingMs: minutesFrom(env, 'WATCHDOG_INDEXING_MINUTES')
  };
  const timeouts = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null) timeouts[key] = value;
  }
  return timeouts;
}

function watchedStatusFilter() {
  return [...WATCHED_STATUSES].map((status) => `status eq '${status}'`).join(' or ');
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUTS,
  WATCHED_STATUSES,
  classifyImport,
  lastProgressAt,
  timeoutsFromEnv,
  watchedStatusFilter
};
