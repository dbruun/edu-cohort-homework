import { useEffect, useMemo, useState } from 'react';

const defaultPolicy = {
  helpLevel: 'guided',
  maxStepsRevealed: 3,
  allowDirectAnswers: false,
  citationsRequired: true,
  subjectOverrides: {
    math: 'guided',
    science: 'hint_only'
  }
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
