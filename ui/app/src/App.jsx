import { useEffect, useMemo, useState } from 'react';

const defaultPolicy = {
  helpLevel: 'guided',
  maxStepsRevealed: 3,
  allowDirectAnswers: false,
  citationsRequired: true,
  subjectOverrides: {
    math: 'guided',
    science: 'hint_only'
  },
  courseGroups: [
    {
      name: 'Group 1 - Intro CS',
      courses: ['CS101', 'CS102'],
      helpLevel: 'hint_only',
      maxStepsRevealed: 1,
      allowDirectAnswers: false,
      citationsRequired: true
    }
  ]
};

export default function App() {
  const [policy, setPolicy] = useState(defaultPolicy);
  const [status, setStatus] = useState('Loading policy from the API...');

  useEffect(() => {
    const loadPolicy = async () => {
      try {
        const response = await fetch('/api/policy');
        if (response.ok) {
          const data = await response.json();
          setPolicy({ ...defaultPolicy, ...data, subjectOverrides: { ...defaultPolicy.subjectOverrides, ...(data.subjectOverrides || {}) } });
          setStatus('Policy loaded from the API.');
          return;
        }
      } catch {
        // ignore and fall back to local defaults
      }

      setStatus('Using local defaults because the API is not available yet.');
    };

    loadPolicy();
  }, []);

  const summary = useMemo(() => {
    return `Help level: ${policy.helpLevel}; steps: ${policy.maxStepsRevealed}; direct answers: ${policy.allowDirectAnswers ? 'allowed' : 'blocked'}`;
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
      { name: `Group ${courseGroups.length + 1}`, courses: [], helpLevel: 'guided', maxStepsRevealed: 3, allowDirectAnswers: false, citationsRequired: true }
    ]);
  };

  const removeGroup = (index) => {
    updateGroups(courseGroups.filter((_, i) => i !== index));
  };

  const updateGroupField = (index, field, value) => {
    updateGroups(courseGroups.map((group, i) => (i === index ? { ...group, [field]: value } : group)));
  };

  const addCourseToGroup = (index, courseId) => {
    const id = courseId.trim();
    if (!id) return;
    updateGroups(
      courseGroups.map((group, i) =>
        i === index && !group.courses.includes(id) ? { ...group, courses: [...group.courses, id] } : group
      )
    );
  };

  const removeCourseFromGroup = (index, courseId) => {
    updateGroups(
      courseGroups.map((group, i) =>
        i === index ? { ...group, courses: group.courses.filter((c) => c !== courseId) } : group
      )
    );
  };

  const savePolicy = async () => {
    try {
      const response = await fetch('/api/policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy)
      });

      if (!response.ok) {
        throw new Error('Request failed');
      }

      const savedPolicy = await response.json();
      setPolicy({ ...defaultPolicy, ...savedPolicy, subjectOverrides: { ...defaultPolicy.subjectOverrides, ...(savedPolicy.subjectOverrides || {}) } });
      setStatus('Policy saved to the API and ready for the agent.');
    } catch {
      setStatus('Could not reach the API. The policy is still staged locally in the UI.');
    }
  };

  return (
    <main style={{ fontFamily: 'Segoe UI, sans-serif', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>Professor Portal</h1>
      <p>Adjust how much support the tutor offers to students without redeploying the agent.</p>

      <section style={{ background: '#f6f8fb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2>Pedagogy controls</h2>
        <label>
          Help style
          <select value={policy.helpLevel} onChange={(event) => updateField('helpLevel', event.target.value)} style={{ display: 'block', marginTop: 8, width: '100%', padding: 8 }}>
            <option value="hint_only">Hint only</option>
            <option value="guided">Guided</option>
            <option value="worked_example">Worked example</option>
            <option value="full_solution">Full solution</option>
          </select>
        </label>

        <label style={{ display: 'block', marginTop: 16 }}>
          Maximum steps revealed
          <input type="range" min="1" max="8" value={policy.maxStepsRevealed} onChange={(event) => updateField('maxStepsRevealed', Number(event.target.value))} style={{ display: 'block', width: '100%', marginTop: 8 }} />
          <span>{policy.maxStepsRevealed}</span>
        </label>

        <label style={{ display: 'block', marginTop: 16 }}>
          <input type="checkbox" checked={policy.allowDirectAnswers} onChange={(event) => updateField('allowDirectAnswers', event.target.checked)} />
          Allow direct answers
        </label>

        <label style={{ display: 'block', marginTop: 16 }}>
          <input type="checkbox" checked={policy.citationsRequired} onChange={(event) => updateField('citationsRequired', event.target.checked)} />
          Require citations
        </label>

        <button onClick={savePolicy} style={{ marginTop: 20, padding: '10px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer' }}>
          Save policy
        </button>
      </section>

      <section style={{ background: '#f6f8fb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Course groups</h2>
          <button onClick={addGroup} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #2563eb', background: 'white', color: '#2563eb', cursor: 'pointer' }}>
            + Add group
          </button>
        </div>
        <p style={{ color: '#5b6b85', marginTop: 6 }}>Group courses that should share the same tutor limits. A course in a group uses the group's limits; anything left unset falls back to the defaults above.</p>

        {courseGroups.length === 0 && <p style={{ color: '#5b6b85' }}>No groups yet. Add one to apply shared limits across several courses.</p>}

        {courseGroups.map((group, index) => (
          <div key={index} style={{ background: 'white', border: '1px solid #dbe2ea', borderRadius: 10, padding: 16, marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={group.name}
                onChange={(event) => updateGroupField(index, 'name', event.target.value)}
                style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #cbd5e1', fontWeight: 600 }}
              />
              <button onClick={() => removeGroup(index)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ef4444', background: 'white', color: '#ef4444', cursor: 'pointer' }}>
                Remove
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {group.courses.map((courseId) => (
                <span key={courseId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eef2ff', color: '#3730a3', borderRadius: 999, padding: '4px 10px', fontSize: 14 }}>
                  {courseId}
                  <button onClick={() => removeCourseFromGroup(index, courseId)} style={{ border: 'none', background: 'transparent', color: '#3730a3', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>
                    ×
                  </button>
                </span>
              ))}
              <input
                placeholder="Add course ID + Enter"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addCourseToGroup(index, event.target.value);
                    event.target.value = '';
                  }
                }}
                style={{ padding: '4px 10px', borderRadius: 999, border: '1px dashed #cbd5e1', fontSize: 14 }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
              <label style={{ fontSize: 14 }}>
                Help style
                <select value={group.helpLevel} onChange={(event) => updateGroupField(index, 'helpLevel', event.target.value)} style={{ display: 'block', marginTop: 6, width: '100%', padding: 8 }}>
                  <option value="hint_only">Hint only</option>
                  <option value="guided">Guided</option>
                  <option value="worked_example">Worked example</option>
                  <option value="full_solution">Full solution</option>
                </select>
              </label>
              <label style={{ fontSize: 14 }}>
                Maximum steps revealed
                <input type="range" min="1" max="8" value={group.maxStepsRevealed} onChange={(event) => updateGroupField(index, 'maxStepsRevealed', Number(event.target.value))} style={{ display: 'block', width: '100%', marginTop: 10 }} />
                <span>{group.maxStepsRevealed}</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 20, marginTop: 12 }}>
              <label style={{ fontSize: 14 }}>
                <input type="checkbox" checked={group.allowDirectAnswers} onChange={(event) => updateGroupField(index, 'allowDirectAnswers', event.target.checked)} />{' '}
                Allow direct answers
              </label>
              <label style={{ fontSize: 14 }}>
                <input type="checkbox" checked={group.citationsRequired} onChange={(event) => updateGroupField(index, 'citationsRequired', event.target.checked)} />{' '}
                Require citations
              </label>
            </div>
          </div>
        ))}
      </section>

      <section style={{ background: '#fff', border: '1px solid #dbe2ea', borderRadius: 12, padding: 20 }}>
        <h2>Knowledge sources</h2>
        <ul>
          <li>course-materials</li>
          <li>assignment-guidance</li>
        </ul>
        <p>{summary}</p>
        <p>{status}</p>
      </section>
    </main>
  );
}
