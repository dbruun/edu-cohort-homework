import { BlockBlobClient } from '@azure/storage-blob';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PedagogyControls, { PedagogyGuide } from './PedagogyControls';
import {
  STAGE_LABELS,
  canCancel,
  documentsLabel,
  finishedLabel,
  formatBytes,
  formatElapsed,
  historyDetail,
  importSize,
  importSubtitle,
  importTitle,
  isInterruptedUpload,
  isTerminal,
  lastUpdatedLabel,
  mergeImports,
  partitionImports,
  pollDelayForRecords,
  pollFailureWarning,
  processingProgress,
  stageDetail,
  stageOf
} from './importView.mjs';

const defaultPolicy = {
  professorId: '',
  professorName: '',
  helpLevel: 'guided',
  citationsRequired: true,
  // The portal has no editor for per-subject overrides, so it never carries them.
  subjectOverrides: {},
  courseGroups: [
    {
      name: 'Group 1 - Intro CS',
      courses: [
        { id: 'CS101', description: 'Introduction to Programming' },
        { id: 'CS102', description: 'Data Structures and Algorithms' }
      ],
      helpLevel: 'guided',
      citationsRequired: true
    }
  ]
};

// The portal stops polling once an import can no longer change on its own.
const stageColors = {
  uploading: { border: 'var(--cp-border-strong)', background: 'var(--cp-accent-soft)', text: 'var(--cp-accent)' },
  processing: { border: 'var(--cp-border-strong)', background: 'var(--cp-accent-soft)', text: 'var(--cp-accent)' },
  ready: { border: 'var(--cp-success-border)', background: 'var(--cp-success-soft)', text: 'var(--cp-success)' },
  attention: { border: 'var(--cp-danger-border)', background: 'var(--cp-danger-soft)', text: 'var(--cp-danger)' }
};

const headerCell = { padding: '8px 10px', fontWeight: 600, borderBottom: '1px solid var(--cp-border)' };
const bodyCell = { padding: '8px 10px', verticalAlign: 'top' };

// The actions column needs a header for anyone navigating the table by column,
// but a visible one would only label two buttons that already say what they do.
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)'
};

export default function App() {
  const [policy, setPolicy] = useState(defaultPolicy);
  const [status, setStatus] = useState('Loading policy from the API...');
  const [imsccFile, setImsccFile] = useState(null);
  // Upload progress is client-side and per import; processing progress is
  // reported by the service. They are deliberately kept apart, because one bar
  // that resets when the upload finishes reads as the work being lost.
  const [imports, setImports] = useState([]);
  const [uploads, setUploads] = useState({});
  const [pollFailures, setPollFailures] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const uploadControllers = useRef(new Map());
  const importsRef = useRef([]);
  const announcedStages = useRef(new Map());
  const fileInput = useRef(null);

  const uploading = Object.keys(uploads).length > 0;

  useEffect(() => {
    importsRef.current = imports;
  }, [imports]);

  // Stage changes are announced; percentages are not, or a screen reader would
  // read every progress tick.
  useEffect(() => {
    for (const record of imports) {
      const stage = stageOf(record.status);
      if (announcedStages.current.get(record.importId) === stage) continue;
      announcedStages.current.set(record.importId, stage);
      setAnnouncement(`${importTitle(record)}: ${STAGE_LABELS[stage]}. ${stageDetail(record)}`);
    }
  }, [imports]);

  // An unmount must not leave uploads running in the background.
  useEffect(() => () => {
    for (const controller of uploadControllers.current.values()) controller.abort();
  }, []);

  const fetchImport = useCallback(async (importId) => {
    const response = await fetch(`/api/imscc-imports/${encodeURIComponent(importId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, []);

  // Import state must not live only in this page: a professor who reloads, or
  // returns on another device, still has to see work that is running.
  useEffect(() => {
    const loadImports = async () => {
      try {
        const response = await fetch('/api/imscc-imports');
        if (!response.ok) return;
        const body = await response.json();
        setImports((current) => mergeImports(current, body.imports || []));
      } catch {
        // A missing history is not an import failure; polling will catch up.
      }
    };
    loadImports();
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = null;

    const loop = async () => {
      if (stopped) return;
      // Polling while the tab is hidden spends the professor's battery to learn
      // something nobody is looking at.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(loop, 1000);
        return;
      }

      const pending = importsRef.current.filter((record) => !isTerminal(record.status));
      if (pending.length) {
        try {
          const updated = await Promise.all(pending.map((record) => fetchImport(record.importId)));
          if (!stopped) {
            setImports((current) => mergeImports(current, updated));
            setPollFailures(0);
          }
        } catch {
          // A status outage is not an import failure, so the records are kept.
          if (!stopped) setPollFailures((failures) => failures + 1);
        }
      }

      if (!stopped) timer = setTimeout(loop, pollDelayForRecords(importsRef.current));
    };

    timer = setTimeout(loop, 3000);
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && !stopped) {
        clearTimeout(timer);
        timer = setTimeout(loop, 0);
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchImport]);

  useEffect(() => {
    const loadPolicy = async () => {
      let identityLoaded = false;
      try {
        const identityResponse = await fetch('/api/me');
        if (identityResponse.ok) {
          const professor = await identityResponse.json();
          setPolicy((current) => ({
            ...current,
            professorId: professor.id,
            professorName: professor.name
          }));
          identityLoaded = true;
        }

        const response = await fetch('/api/policy');
        if (response.ok) {
          const data = await response.json();
          setPolicy({ ...defaultPolicy, ...data, subjectOverrides: {} });
          setStatus('Policy loaded from the API.');
          return;
        }
      } catch {
        // ignore and fall back to local defaults
      }

      setStatus(identityLoaded
        ? 'Signed in, but the saved policy could not be loaded.'
        : 'Sign in through the deployed portal to load your professor profile.');
    };

    loadPolicy();
  }, []);

  const summary = useMemo(() => {
    return `Help level: ${policy.helpLevel}`;
  }, [policy]);

  const updateField = (field, value) => {
    setPolicy((current) => ({ ...current, [field]: value }));
  };

  const courseGroups = policy.courseGroups || [];

  const updateGroups = (groups) => {
    setPolicy((current) => ({ ...current, courseGroups: groups }));
  };

  const addGroup = () => {
    updateGroups([
      ...courseGroups,
      { name: `Group ${courseGroups.length + 1}`, courses: [], helpLevel: 'guided', citationsRequired: true }
    ]);
  };

  const removeGroup = (index) => {
    updateGroups(courseGroups.filter((_, i) => i !== index));
  };

  const updateGroupField = (index, field, value) => {
    updateGroups(courseGroups.map((group, i) => (i === index ? { ...group, [field]: value } : group)));
  };

  const addCourseToGroup = (index, courseId, courseDescription) => {
    const id = courseId.trim();
    if (!id) return;
    updateGroups(
      courseGroups.map((group, i) =>
        i === index && !group.courses.some((c) => c.id === id)
          ? { ...group, courses: [...group.courses, { id, description: (courseDescription || '').trim() }] }
          : group
      )
    );
  };

  const addCourseFromRow = (index, row) => {
    const idInput = row.querySelector('[data-role="course-id"]');
    const descriptionInput = row.querySelector('[data-role="course-desc"]');
    addCourseToGroup(index, idInput.value, descriptionInput.value);
    idInput.value = '';
    descriptionInput.value = '';
    idInput.focus();
  };

  const removeCourseFromGroup = (index, courseId) => {
    updateGroups(
      courseGroups.map((group, i) =>
        i === index ? { ...group, courses: group.courses.filter((c) => c.id !== courseId) } : group
      )
    );
  };

  const savePolicy = async () => {
    setStatus('Saving policy...');
    try {
      const response = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy)
      });

      const savedPolicy = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(savedPolicy.error || `HTTP ${response.status}`);
      }

      setPolicy({ ...defaultPolicy, ...savedPolicy, subjectOverrides: {} });
      // Saving stores the policy; the tutor only sees it once the indexer runs.
      setStatus(savedPolicy.indexerTriggered
        ? 'Policy saved and reindexed. Allow 60 seconds for data to refresh.'
        : `Policy saved, but reindexing did not start (${savedPolicy.indexerReason || 'reason unknown'}). The tutor is still answering from the previous policy.`);
    } catch (error) {
      setStatus(`Save failed - nothing was stored. ${error.message}`);
    }
  };

  const importImscc = async () => {
    if (!imsccFile) {
      setStatus('Choose a Canvas course export.');
      return;
    }
    const file = imsccFile;
    const controller = new AbortController();
    setStatus('Preparing secure upload...');
    let importId = null;
    try {
      const createResponse = await fetch('/api/imscc-imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originalFileName: file.name, fileSize: file.size }),
        signal: controller.signal
      });
      const created = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok) throw new Error(created.error || `HTTP ${createResponse.status}`);

      importId = created.importId;
      uploadControllers.current.set(importId, controller);
      const record = {
        importId,
        status: 'uploading',
        originalFileName: file.name,
        expectedBytes: file.size,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      setImports((current) => mergeImports([record, ...current], []));
      setUploads((current) => ({ ...current, [importId]: { loaded: 0, total: file.size } }));
      setImsccFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setStatus('Uploading Canvas course export...');

      const blob = new BlockBlobClient(created.uploadUrl);
      await blob.uploadBrowserData(file, {
        blockSize: 16 * 1024 * 1024,
        concurrency: 4,
        abortSignal: controller.signal,
        blobHTTPHeaders: { blobContentType: 'application/vnd.ims.imsccv1p3' },
        onProgress: ({ loadedBytes }) => {
          setUploads((current) => (current[importId]
            ? { ...current, [importId]: { loaded: loadedBytes, total: file.size } }
            : current));
        }
      });

      setImports((current) => mergeImports(current, [{ importId, status: 'uploaded', updatedAt: new Date().toISOString() }]));
      setStatus('Upload complete. Processing continues here, and survives closing this page.');
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') setStatus('Import cancelled. No course content was added.');
      else setStatus(`Upload failed - no course content was added. ${error.message}`);
    } finally {
      if (importId) {
        uploadControllers.current.delete(importId);
        setUploads((current) => {
          const next = { ...current };
          delete next[importId];
          return next;
        });
      }
    }
  };

  const cancelImport = async (importId) => {
    // During upload this stops the transfer; afterwards it records a request
    // the pipeline honours at its next checkpoint.
    uploadControllers.current.get(importId)?.abort();
    try {
      const response = await fetch(`/api/imscc-imports/${encodeURIComponent(importId)}/cancel`, { method: 'POST' });
      const record = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(record.error || `HTTP ${response.status}`);
      setImports((current) => mergeImports(current, [record]));
    } catch (error) {
      setStatus(`The upload stopped, but cancelling the import failed. ${error.message}`);
    }
  };

  // Retry never reuses the previous upload session: both the SAS and the
  // partially uploaded blob may be gone.
  const retryImport = () => {
    setStatus('Choose the course export again to retry.');
    fileInput.current?.click();
  };

  // One shared status, rendered beside whichever button the professor just used.
  const statusLine = <span style={{ color: 'var(--cp-text-muted)', fontSize: 14 }}>{status}</span>;
  const pollWarning = pollFailureWarning(pollFailures);
  const activeUploadIds = useMemo(() => new Set(Object.keys(uploads)), [uploads]);
  // Running work and finished work answer different questions, so they are shown
  // as a panel per import and a table of what has already happened.
  const { active: activeImports, history: importHistory } = useMemo(
    () => partitionImports(imports),
    [imports]
  );

  return (
    <>
      <header className="page-header">
        <div className="brand">
          <span className="mark" aria-hidden="true">CW</span>
          <div>
            <strong>CourseWise Professor</strong>
            <small>Teaching settings &amp; course materials</small>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-identity">{policy.professorName || 'Professor workspace'}</span>
          <a href="/.auth/logout">Sign out</a>
        </div>
      </header>
      <main className="portal-main">
        <div className="page-intro">
          <span className="eyebrow">YOUR TEACHING WORKSPACE</span>
          <h1>Shape how students learn.</h1>
          <p>Adjust how much support the tutor offers to students without redeploying the agent.</p>
        </div>

      <PedagogyGuide />

      <section className="portal-panel" aria-labelledby="content-heading">
        <h2 id="content-heading">Course upload</h2>
        <p>Upload a Canvas course export (.imscc). The course name is read from the package metadata after upload.</p>
        <input
          ref={fileInput}
          type="file"
          accept=".imscc,application/zip"
          aria-label="Canvas course export"
          onChange={(event) => setImsccFile(event.target.files?.[0] || null)}
        />
        <fieldset className="upload-options" disabled aria-describedby="upload-options-note">
          <legend>Additional content</legend>
          <label><input type="checkbox" disabled />Include multimedia files</label>
          <label><input type="checkbox" disabled />Include public links</label>
          <p id="upload-options-note">Coming soon. These options are not included in course imports.</p>
        </fieldset>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            onClick={importImscc}
            disabled={!imsccFile || uploading}
            className="primary"
          >
            {uploading ? 'Uploading...' : 'Import Canvas export'}
          </button>
          {statusLine}
        </div>

        {/* Stage changes are announced here; progress percentages are not. */}
        <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {announcement}
        </div>

        {pollWarning ? (
          <p role="status" style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'var(--cp-warning-soft)', border: '1px solid var(--cp-warning-border)', color: 'var(--cp-warning)' }}>
            {pollWarning}
          </p>
        ) : null}

        {activeImports.length ? (
          <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
            {activeImports.map((record) => {
              const stage = stageOf(record.status);
              const colors = stageColors[stage];
              const upload = uploads[record.importId];
              const progress = processingProgress(record);
              const interrupted = isInterruptedUpload(record, activeUploadIds);
              const uploadPercent = upload && upload.total
                ? Math.round((upload.loaded / upload.total) * 100)
                : null;

              return (
                <article
                  key={record.importId}
                  style={{ border: `1px solid ${colors.border}`, background: colors.background, borderRadius: 10, padding: 14 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <strong style={{ fontSize: 15 }}>{importTitle(record)}</strong>
                      {importSubtitle(record) ? (
                        <div style={{ color: 'var(--cp-text-muted)', fontSize: 13 }}>{importSubtitle(record)}</div>
                      ) : null}
                    </div>
                    <span style={{ color: colors.text, fontWeight: 600, fontSize: 13 }}>
                      {interrupted ? 'Interrupted' : STAGE_LABELS[stage]}
                    </span>
                  </div>

                  <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--cp-text)' }}>
                    {interrupted
                      ? 'This upload stopped when the page was closed. Only your browser held the file, so it cannot be resumed.'
                      : stageDetail(record)}
                  </p>

                  {uploadPercent !== null ? (
                    <div style={{ marginTop: 10 }}>
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={uploadPercent}
                        aria-label={`Uploading ${importTitle(record)}`}
                        style={{ background: 'var(--cp-border)', borderRadius: 999, height: 8, overflow: 'hidden' }}
                      >
                        <div style={{ width: `${uploadPercent}%`, background: 'var(--cp-accent)', height: '100%' }} />
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--cp-text-muted)', marginTop: 4 }}>
                        {uploadPercent}% - {formatBytes(upload.loaded)} of {formatBytes(upload.total)}
                      </div>
                    </div>
                  ) : null}

                  {stage === 'processing' ? (
                    <div style={{ marginTop: 8, fontSize: 13, color: 'var(--cp-text-muted)' }}>
                      {progress.known
                        ? `${progress.indexed} of ${progress.discovered} documents indexed`
                        : 'Counting documents...'}
                      {' - '}
                      {formatElapsed(record.createdAt)} elapsed
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    {canCancel(record) ? (
                      <button
                        onClick={() => cancelImport(record.importId)}
                        className="danger"
                      >
                        Cancel
                      </button>
                    ) : null}
                    {/* An upload the browser can no longer resume is still running as
                        far as the record is concerned, so it stays in the panel and
                        offers the only action that helps. */}
                    {interrupted ? (
                      <button
                        onClick={retryImport}
                      >
                        Import again
                      </button>
                    ) : null}
                    <span style={{ fontSize: 12, color: 'var(--cp-text-soft)' }}>{lastUpdatedLabel(record)}</span>
                  </div>

                  <div style={{ fontSize: 11, color: 'var(--cp-text-soft)', marginTop: 6 }}>
                    Reference: {record.importId}
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        {importHistory.length ? (
          <div style={{ marginTop: 24 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Import history</h3>
            {importHistory.some(record => record.isDemo) ? (
              <p style={{ fontSize: 13 }}>Entries marked Demo are fabricated upload history. No course archives were uploaded for these entries.</p>
            ) : null}
            <div style={{ overflowX: 'auto', position: 'relative' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <caption style={{ captionSide: 'top', textAlign: 'left', color: 'var(--cp-text-muted)', fontSize: 13, paddingBottom: 6 }}>
                  Course exports that have finished importing, most recent first.
                </caption>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--cp-text-muted)' }}>
                    <th scope="col" style={headerCell}>File</th>
                    <th scope="col" style={headerCell}>Course name</th>
                    <th scope="col" style={headerCell}>Status</th>
                    <th scope="col" style={{ ...headerCell, textAlign: 'right' }}>Documents indexed</th>
                    <th scope="col" style={{ ...headerCell, textAlign: 'right' }}>Size</th>
                    <th scope="col" style={headerCell}>Finished</th>
                    <th scope="col" style={headerCell}>
                      <span style={visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {importHistory.map((record) => {
                    const stage = stageOf(record.status);
                    const colors = stageColors[stage];
                    const detail = historyDetail(record);

                    return (
                      <Fragment key={record.importId}>
                        <tr style={{ borderTop: '1px solid var(--cp-border)' }}>
                          <td style={bodyCell}>
                            {record.originalFileName || '-'}
                            {record.isDemo ? <span className="demo-badge" title="Fabricated upload history">Demo</span> : null}
                          </td>
                          <td style={bodyCell}>{record.courseName || '-'}</td>
                          <td style={{ ...bodyCell, color: colors.text, fontWeight: 600 }}>
                            {STAGE_LABELS[stage]}
                          </td>
                          <td style={{ ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {documentsLabel(record)}
                          </td>
                          <td style={{ ...bodyCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {importSize(record)}
                          </td>
                          <td style={bodyCell}>{finishedLabel(record)}</td>
                          <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>
                            {detail ? (
                              <button
                                onClick={retryImport}
                              >
                                Import again
                              </button>
                            ) : null}
                          </td>
                        </tr>
                        {/* A status word is not something a professor can act on, so a
                            failed row keeps the guidance and the support reference. */}
                        {detail ? (
                          <tr style={{ background: colors.background }}>
                            <td colSpan={7} style={{ ...bodyCell, color: 'var(--cp-text)' }}>
                              {detail.message} {detail.action}
                              {detail.contentUnchanged ? ' Previously published course content was not changed.' : ''}
                              <span style={{ display: 'block', color: 'var(--cp-text-soft)', fontSize: 11, marginTop: 4 }}>
                                Reference: {detail.reference}
                              </span>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

      </section>

      <section className="portal-panel" aria-labelledby="groups-heading">
        <div className="section-heading">
          <h2 id="groups-heading">Course groups</h2>
          <button onClick={addGroup}>
            + Add group
          </button>
        </div>
        <p style={{ marginTop: 12 }}>Group courses that should share teaching preferences. A course uses its group's settings; anything left unset falls back to the Default settings below.</p>

        {courseGroups.length === 0 && <p>No groups yet. Add one to apply shared preferences across several courses.</p>}

        {courseGroups.map((group, index) => (
          <div key={index} className="course-group">
            <div className="group-heading">
              <input
                value={group.name}
                onChange={(event) => updateGroupField(index, 'name', event.target.value)}
                aria-label={`Course group ${index + 1} name`}
              />
              <button onClick={() => removeGroup(index)} className="danger">
                Remove
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {group.courses.map((course) => (
                <span key={course.id} title={course.description} className="course-tag">
                  <strong>{course.id}</strong>
                  {course.description ? <span>&mdash; {course.description}</span> : null}
                  <button onClick={() => removeCourseFromGroup(index, course.id)} aria-label={`Remove ${course.id} from ${group.name}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="course-entry">
              <input
                placeholder="Course ID"
                data-role="course-id"
                aria-label={`Course ID for ${group.name}`}
              />
              <input
                placeholder="Description"
                data-role="course-desc"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addCourseFromRow(index, event.currentTarget.parentElement);
                  }
                }}
                aria-label={`Course description for ${group.name}`}
              />
              <button
                type="button"
                aria-label={`Add course to ${group.name}`}
                title="Add course"
                onClick={(event) => addCourseFromRow(index, event.currentTarget.parentElement)}
                className="primary"
              >
                +
              </button>
            </div>

            <PedagogyControls
              helpLevel={group.helpLevel ?? policy.helpLevel}
              citationsRequired={group.citationsRequired ?? policy.citationsRequired}
              onChange={(field, value) => updateGroupField(index, field, value)}
            />
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={savePolicy} className="primary">
            Save course groups
          </button>
          {statusLine}
        </div>
      </section>

      <section className="portal-panel" aria-labelledby="pedagogy-heading">
        <h2 id="pedagogy-heading">Default</h2>
        <PedagogyControls
          helpLevel={policy.helpLevel}
          citationsRequired={policy.citationsRequired}
          onChange={updateField}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
          <button onClick={savePolicy} className="primary">
            Save policy
          </button>
          {statusLine}
        </div>
        <p>{summary}</p>
      </section>

      <section className="portal-panel" aria-labelledby="professor-heading">
        <h2 id="professor-heading">Professor</h2>
        <p style={{ marginTop: 0 }}>This pedagogy belongs to you. Students taking courses from other professors get each professor's own settings.</p>
        <div className="identity-fields">
          <label>
            Name
            <input value={policy.professorName || ''} placeholder="Loading signed-in professor..." readOnly />
          </label>
          <label>
            Professor ID
            <input value={policy.professorId || ''} placeholder="Provided by Microsoft Entra ID" readOnly />
          </label>
        </div>
      </section>
      </main>
      <footer className="site-footer">
        <strong>CourseWise Professor</strong>
        <span>Your courses. Your teaching approach.</span>
      </footer>
    </>
  );
}
