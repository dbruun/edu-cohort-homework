import { useId, useRef } from 'react';

const helpStyles = [
  { value: 'guided', label: 'Guided', description: 'Guides students through the problem with prompts and partial steps, then pauses for their contribution without giving the original final answer.' },
  { value: 'worked_example', label: 'Worked example', description: 'Works through a different, similar example in full so students can apply the method to their own question. Does not give the original final answer.' },
  { value: 'full_solution', label: 'Full solution', description: "Works through the student's original question and provides the final answer." }
];

const citationsDescription = 'When on, the tutor must cite course materials to support its responses. When off, citations are optional, not prohibited.';

export function PedagogyGuide() {
  const headingId = useId();
  const dialogHeadingId = useId();
  const dialog = useRef(null);

  return (
    <section className="portal-panel pedagogy-guide" aria-labelledby={headingId}>
      <span className="eyebrow">UNDERSTAND THE CONTROLS</span>
      <div className="section-heading">
        <h2 id={headingId}>Pedagogy guide</h2>
        <button type="button" onClick={() => dialog.current.showModal()}>Create custom help style</button>
      </div>
      <p className="pedagogy-guide-intro">Choose how much help students receive. These styles apply to both course groups and Default settings.</p>
      <div className="pedagogy-guide-styles">
        {helpStyles.map((style) => (
          <div key={style.value} className="pedagogy-guide-style">
            <h3>{style.label}</h3>
            <p>{style.description}</p>
          </div>
        ))}
      </div>
      <div className="pedagogy-guide-citations">
        <h3>Require citations</h3>
        <p>{citationsDescription}</p>
      </div>
      <dialog ref={dialog} className="pedagogy-dialog" aria-labelledby={dialogHeadingId}>
        <form method="dialog">
          <h2 id={dialogHeadingId}>Custom help style</h2>
          <label>
            How should the tutor help students?
            <textarea name="category" rows={7} autoFocus />
          </label>
          <div className="pedagogy-dialog-actions">
            <button type="submit" value="cancel">Cancel</button>
            <button type="submit" value="save" className="primary">Save help style</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

export default function PedagogyControls({ helpLevel, citationsRequired, onChange }) {
  const id = useId();
  const helpDescriptionId = `${id}-help-description`;
  const citationsDescriptionId = `${id}-citations-description`;

  return (
    <div className="pedagogy-controls">
      <div>
        <label>
          Help style
          <select value={helpLevel} onChange={(event) => onChange('helpLevel', event.target.value)} aria-describedby={helpDescriptionId}>
            {helpStyles.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
          </select>
        </label>
        <p id={helpDescriptionId} className="control-description">
          {helpStyles.find((style) => style.value === helpLevel)?.description}
        </p>
      </div>
      <div>
        <label>
          <input type="checkbox" checked={citationsRequired} onChange={(event) => onChange('citationsRequired', event.target.checked)} aria-describedby={citationsDescriptionId} />
          Require citations
        </label>
        <p id={citationsDescriptionId} className="control-description">
          {citationsDescription}
        </p>
      </div>
    </div>
  );
}
