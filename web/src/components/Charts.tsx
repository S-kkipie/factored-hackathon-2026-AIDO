import { useId, useState } from "react";

/**
 * Single-series charts (one validated data hue, labels in text ink). Every mark has a hover/focus tooltip and the
 * figure exposes a screen-reader table, so value and identity never depend on color alone.
 */

export interface Datum {
  label: string;
  value: number;
  /** Formatted value shown as the direct label and in the tooltip. */
  display: string;
  /** Extra tooltip line (e.g. "12 compras"). */
  detail?: string;
}

function SrTable({ caption, items }: { caption: string; items: Datum[] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <tbody>
        {items.map((d) => (
          <tr key={d.label}>
            <th scope="row">{d.label}</th>
            <td>{d.display}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal bars for ranked categories: label left, value right, bar anchored at zero. */
export function BarList({ items, caption, empty }: { items: Datum[]; caption: string; empty?: string }) {
  const max = Math.max(0, ...items.map((d) => d.value));
  if (items.length === 0 || max === 0) return <p className="muted small">{empty ?? "Sin datos."}</p>;
  return (
    <figure className="barlist" aria-label={caption}>
      {items.map((d) => (
        <div key={d.label} className="barlist-row" tabIndex={0} aria-label={`${d.label}: ${d.display}`}>
          <span className="barlist-label">{d.label}</span>
          <span className="barlist-track" aria-hidden="true">
            <span className="barlist-bar" style={{ width: `${Math.max(1.5, (d.value / max) * 100)}%` }} />
          </span>
          <span className="barlist-value">{d.display}</span>
          {d.detail && (
            <span className="tip" role="tooltip">
              <strong>{d.label}</strong> · {d.display}
              <br />
              {d.detail}
            </span>
          )}
        </div>
      ))}
      <SrTable caption={caption} items={items} />
    </figure>
  );
}

/** Vertical columns for change over time; the hovered column shows its exact value. */
export function Columns({ items, caption, height = 140 }: { items: Datum[]; caption: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const max = Math.max(0, ...items.map((d) => d.value));
  if (items.length === 0 || max === 0) return <p className="muted small">Sin datos.</p>;
  return (
    <figure className="columns" aria-labelledby={id}>
      <figcaption id={id} className="sr-only">
        {caption}
      </figcaption>
      <div className="columns-plot" style={{ height }} onMouseLeave={() => setHover(null)}>
        <span className="columns-max muted small" aria-hidden="true">
          {items.reduce((a, b) => (b.value > a.value ? b : a)).display}
        </span>
        {items.map((d, i) => (
          <div
            key={d.label}
            className={`columns-slot${hover === i ? " on" : ""}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            tabIndex={0}
            aria-label={`${d.label}: ${d.display}`}
          >
            <span className="columns-bar" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />
            {hover === i && (
              <span className="tip up" role="tooltip">
                <strong>{d.label}</strong>
                <br />
                {d.display}
                {d.detail && (
                  <>
                    <br />
                    {d.detail}
                  </>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="columns-axis" aria-hidden="true">
        {items.map((d, i) => (
          <span key={d.label} className={items.length > 12 && i % Math.ceil(items.length / 8) !== 0 ? "hide" : ""}>
            {d.label}
          </span>
        ))}
      </div>
      <SrTable caption={caption} items={items} />
    </figure>
  );
}

/** A headline number with a label and optional context line. */
export function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}
