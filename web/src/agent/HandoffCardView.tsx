import type { HandoffCard } from "../lib/api";
import { ruleText } from "../lib/rules-text";

/** Structured handoff payload (spec 3.3). Every field is rendered as text. */
export function HandoffCardView({ card }: { card: HandoffCard }) {
  return (
    <div>
      <p>{card.summary}</p>
      <div className="chips">
        {card.ruleIds.map((r) => (
          <span key={r} className="chip warn mono" title={ruleText(r)}>
            {r}
          </span>
        ))}
        <span className="chip">{card.language.toUpperCase()}</span>
        {card.sentiment && <span className="chip">{card.sentiment}</span>}
      </div>
      {card.ruleIds.length > 0 && (
        <div className="card-section">
          <h4>Por qué se derivó</h4>
          <ul>
            {card.ruleIds.map((r) => (
              <li key={r}>
                <span className="mono">{r}</span>: {ruleText(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.verifiedFacts.length > 0 && (
        <div className="card-section">
          <h4>Hechos verificados</h4>
          <ul>
            {card.verifiedFacts.map((f) => (
              <li key={`${f.kind}-${f.id}`}>
                <span className="mono">{f.id}</span> ({f.kind}): {f.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.actionsTaken.length > 0 && (
        <div className="card-section">
          <h4>Acciones realizadas</h4>
          <ul>
            {card.actionsTaken.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {card.openQuestions.length > 0 && (
        <div className="card-section">
          <h4>Preguntas abiertas</h4>
          <ul>
            {card.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
