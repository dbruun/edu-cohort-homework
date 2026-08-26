// Presentation rules for the import status view.
//
// These live outside the component because they decide what a professor is told
// about their work, which is worth testing directly rather than through a
// rendered tree.

export const TERMINAL_STATUSES = new Set([
  'complete',
  'cancelled',
  'failed-validation',
  'failed-processing',
  'failed-indexing',
  'upload-expired'
]);

// The pipeline's internal states change as it gains steps. These four do not,
// so the wording a professor sees stays stable underneath them.
const STATUS_STAGES = {
  uploading: 'uploading',
  uploaded: 'processing',
  queued: 'processing',
  extracting: 'processing',
  indexing: 'processing',
  complete: 'ready',
  cancelled: 'attention',
  'failed-validation': 'attention',
  'failed-processing': 'attention',
  'failed-indexing': 'attention',
  'upload-expired': 'attention'
};

export const STAGE_LABELS = {
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  attention: 'Needs attention'
};

const STAGE_DETAIL = {
  uploaded: 'Upload complete. Waiting for processing to start.',
  queued: 'Queued for processing.',
  extracting: 'Reading the course package.',
  indexing: 'Adding course content to the knowledge base.'
};

// An unknown status must not be presented as success. Anything the portal does
// not recognise is something a professor should look at.
export function stageOf(status) {
  return STATUS_STAGES[status] || 'attention';
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

// Every failure says what happened, what to do, and that existing course
// content was left alone, which is the professor's first concern.
const FAILURE_GUIDANCE = {
  'failed-validation': {
    message: 'This file could not be read as a Canvas course export.',
    action: 'Re-export the course from Canvas, then import the new file.'
  },
  'failed-processing': {
    message: 'The course export could not be processed.',
    action: 'Try importing again. If it fails a second time, contact support with the reference below.'
  },
  'failed-indexing': {
    message: 'The course content was read but could not be published to the tutor.',
    action: 'Try importing again.'
  },
  'upload-expired': {
    message: 'The upload did not finish before the secure upload window closed.',
    action: 'Import again, ideally on a faster or more stable connection.'
  },
  cancelled: {
    message: 'This import was cancelled.',
    action: 'Start a new import when you are ready.'
  }
};

export function failureGuidance(status) {
  const known = FAILURE_GUIDANCE[status];
  if (known) return { ...known, contentUnchanged: true };
  return {
    message: 'This import stopped in an unexpected state.',
    action: 'Try importing again, and contact support with the reference below if it recurs.',
    contentUnchanged: true
  };
}

// The card is titled by the filename until extraction reports the package
// title, because the professor no longer supplies a course name.
export function importTitle(record) {
  return record.courseName || record.originalFileName || 'Course import';
}

export function importSubtitle(record) {
  return record.courseName && record.originalFileName ? record.originalFileName : '';
}

export function stageDetail(record) {
  if (record.status === 'uploading') return 'Transferring the file from this browser.';
  if (record.status === 'complete') {
    const count = Number(record.documentsIndexed) || 0;
    return `${count} document${count === 1 ? '' : 's'} are available to the tutor.`;
  }
  if (stageOf(record.status) === 'attention') return failureGuidance(record.status).message;
  return STAGE_DETAIL[record.status] || 'Working on this import.';
}

// Processing progress is only real once extraction has counted the documents.
// Until then the view must show an indeterminate indicator rather than invent a
// percentage, and it must never share a bar with upload progress: a single bar
// that returns to zero reads as work being lost.
export function processingProgress(record) {
  const discovered = Number(record.documentsDiscovered) || 0;
  const indexed = Number(record.documentsIndexed) || 0;
  if (discovered <= 0) return { known: false, indexed, discovered: 0, percent: null };
  return {
    known: true,
    indexed,
    discovered,
    percent: Math.min(100, Math.round((indexed / discovered) * 100))
  };
}

// Frequent polling is only useful while an import is young. A long extraction
// would otherwise generate sustained load for no extra information.
export const FAST_POLL_MS = 3000;
export const SLOW_POLL_MS = 15000;
export const FAST_POLL_WINDOW_MS = 2 * 60 * 1000;

export function pollDelayMs(elapsedMs) {
  return elapsedMs < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
}

// The cadence follows the youngest running import. A page left open for an hour
// must still poll quickly when a new import is started on it.
export function pollDelayForRecords(records, now = Date.now()) {
  const ages = records
    .filter((record) => !isTerminal(record.status))
    .map((record) => now - new Date(record.createdAt).getTime())
    .filter((age) => Number.isFinite(age));
  if (!ages.length) return SLOW_POLL_MS;
  return pollDelayMs(Math.min(...ages));
}

// Polling replaces records in place. Rebuilding the list from the responses
// would drop an import that was created locally but has not been polled yet,
// making a just-started upload vanish from the view.
export function mergeImports(current, updates) {
  const byId = new Map(current.map((record) => [record.importId, record]));
  for (const update of updates) {
    if (!update || !update.importId) continue;
    byId.set(update.importId, { ...byId.get(update.importId), ...update });
  }
  return [...byId.values()];
}

// A status request failing is not the import failing. The professor is only
// warned once the portal has genuinely lost touch with the service.
export const POLL_FAILURES_BEFORE_WARNING = 3;

export function pollFailureWarning(consecutiveFailures) {
  if (consecutiveFailures < POLL_FAILURES_BEFORE_WARNING) return '';
  return 'Cannot reach the service for status updates. Your import is still running; this page will catch up when the connection returns.';
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

export function formatElapsed(fromIso, now = Date.now()) {
  const start = new Date(fromIso).getTime();
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// "Last updated" makes a stalled import visible rather than merely quiet.
export function lastUpdatedLabel(record, now = Date.now()) {
  const elapsed = formatElapsed(record.updatedAt, now);
  return elapsed ? `Updated ${elapsed} ago` : '';
}

// Only the browser held the file, so an upload interrupted by a reload cannot
// resume. Saying so is better than showing a progress bar that will never move.
export function isInterruptedUpload(record, activeUploadIds) {
  return record.status === 'uploading' && !activeUploadIds.has(record.importId);
}

export function canCancel(record) {
  return !isTerminal(record.status);
}

// Active work and finished work answer different questions, so they are shown
// differently: a panel per running import, and a table of what has already
// happened. Splitting here rather than in the component keeps the rule that
// decides which is which testable, and keeps it in one place.
//
// Newest first in both. A professor who has just started an import looks at the
// top of the page, and the row they most often want in the history is the one
// that finished last.
export function partitionImports(records) {
  const active = [];
  const history = [];
  for (const record of records || []) {
    if (isTerminal(record.status)) history.push(record);
    else active.push(record);
  }
  const byCreatedDescending = (a, b) => timeOf(b.createdAt) - timeOf(a.createdAt);
  const byUpdatedDescending = (a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt);
  return { active: active.sort(byCreatedDescending), history: history.sort(byUpdatedDescending) };
}

// A record missing or carrying an unparseable timestamp must not sort ahead of
// real work, so it goes to the end rather than to the top.
function timeOf(iso) {
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : -Infinity;
}

// The history says what a professor ended up with, so a successful row reports
// what the tutor can now use. A row that failed indexed nothing, and claiming
// a partial count would suggest content is available when none of it is.
export function documentsLabel(record) {
  if (record.status !== 'complete') return '-';
  return String(Number(record.documentsIndexed) || 0);
}

// The table shows the size the browser set out to upload. uploadedBytes is
// progress, not size, and for anything that failed part-way it would report a
// file smaller than the one the professor chose.
export function importSize(record) {
  return formatBytes(record.expectedBytes) || '-';
}

// A finished import is dated by when it stopped, not when it began.
export function finishedLabel(record, now = Date.now()) {
  const elapsed = formatElapsed(record.updatedAt, now);
  return elapsed ? `${elapsed} ago` : '-';
}

// Table cells cannot carry the failure guidance, but a professor cannot act on
// a status word alone, so a failed row keeps the full text beneath it.
export function historyDetail(record) {
  if (stageOf(record.status) !== 'attention') return null;
  const guidance = failureGuidance(record.status);
  return {
    message: guidance.message,
    action: guidance.action,
    contentUnchanged: guidance.contentUnchanged,
    reference: record.importId
  };
}
