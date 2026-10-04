import { useId } from "react";

/**
 * AIDO mark: a speech bubble (conversation) holding a gold four-point spark (assistance), on a deep emerald
 * squircle. Reads at 16 px (favicon) and scales to hero sizes.
 */
export function Logo({ size = 32, plain = false }: { size?: number; plain?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#11785f" />
          <stop offset="1" stopColor="#062f27" />
        </linearGradient>
        <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3d27a" />
          <stop offset="1" stopColor="#c08e1f" />
        </linearGradient>
      </defs>
      {!plain && <rect width="48" height="48" rx="14" fill={`url(#${id}-bg)`} />}
      {/* bubble ring with tail */}
      <path
        d="M24 10.5c8.3 0 14.5 5.7 14.5 12.9S32.3 36.3 24 36.3c-1.6 0-3.1-.2-4.5-.6l-6.6 3.4 1.6-6.2c-2.9-2.3-4.9-5.7-4.9-9.5 0-7.2 6.1-12.9 14.4-12.9Z"
        fill="none"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      {/* spark */}
      <path d="M24 16.2c.6 3.9 2.3 5.7 6.4 7.1-4.1 1.4-5.8 3.2-6.4 7.1-.6-3.9-2.3-5.7-6.4-7.1 4.1-1.4 5.8-3.2 6.4-7.1Z" fill={`url(#${id}-gold)`} />
    </svg>
  );
}

/** Lowercase wordmark; the dot of the "i" is the brand's gold spark. */
export function Wordmark({ size = 32, sub, light = false }: { size?: number; sub?: string; light?: boolean }) {
  return (
    <span className={`wordmark${light ? " light" : ""}`}>
      <Logo size={size} />
      <span className="wordmark-text">
        <span className="wordmark-name" style={{ fontSize: Math.round(size * 0.62) }}>
          a<span className="wm-i">ı<span className="wm-dot" /></span>do
        </span>
        {sub && <span className="wordmark-sub">{sub}</span>}
      </span>
    </span>
  );
}

export function Avatar({ who }: { who: "assistant" | "agent" }) {
  return who === "assistant" ? (
    <span className="avatar assistant" aria-hidden="true">
      <Logo size={32} />
    </span>
  ) : (
    <span className="avatar agent" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="8" r="4" fill="currentColor" />
        <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="currentColor" />
      </svg>
    </span>
  );
}

// ── decorative security-print patterns ───────────────────────────────────────────────────────────────────────

/** Hypotrochoid curve, the basis of banknote guilloché. */
function hypotrochoid(R: number, r: number, d: number, cx: number, cy: number, turns: number, steps = Math.max(900, turns * 260)): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    const x = cx + (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = cy + (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}

const ROSETTE = [
  hypotrochoid(150, 52, 70, 200, 200, 13),
  hypotrochoid(150, 37.5, 80, 200, 200, 3),
  hypotrochoid(120, 45, 60, 200, 200, 3),
  hypotrochoid(170, 34, 40, 200, 200, 1),
];

/** Banknote-style rosette. Purely decorative; color comes from `currentColor`. */
export function Guilloche({ className = "", opacity = 0.35 }: { className?: string; opacity?: number }) {
  return (
    <svg className={`guilloche ${className}`} viewBox="0 0 400 400" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.6" opacity={opacity}>
        {ROSETTE.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

const WAVES = Array.from({ length: 22 }, (_, i) => {
  const y = 10 + i * 9;
  let d = `M0 ${y}`;
  for (let x = 0; x <= 400; x += 10) d += ` L${x} ${(y + Math.sin(x / 34 + i * 0.55) * 6).toFixed(1)}`;
  return d;
});

/** Fine wave lines, as on the edges of a cheque. */
export function Waves({ className = "", opacity = 0.25 }: { className?: string; opacity?: number }) {
  return (
    <svg className={`waves ${className}`} viewBox="0 0 400 210" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.7" opacity={opacity}>
        {WAVES.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** The AIDO card, for heroes and the credit-card product. Shows only the masked number. */
export function BankCard({ masked = "•••• 2370", label = "Crédito", holder, compact = false }: { masked?: string; label?: string; holder?: string; compact?: boolean }) {
  const last4 = masked.replace(/\D/g, "").slice(-4) || "0000";
  return (
    <div className={`bank-card${compact ? " compact" : ""}`} role="img" aria-label={`Tarjeta AIDO ${label} terminada en ${last4}`}>
      <Guilloche className="bank-card-rosette" opacity={0.5} />
      <div className="bank-card-top">
        <Wordmark size={compact ? 22 : 28} light />
        <span className="bank-card-label">{label}</span>
      </div>
      <div className="bank-card-chip" aria-hidden="true">
        <span />
        <svg viewBox="0 0 24 24" width="22" height="22" className="contactless">
          <path d="M8 7c2 2.8 2 7.2 0 10M12 5c3 4 3 10 0 14M16 3c4 5.4 4 12.6 0 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="bank-card-number">•••• •••• •••• {last4}</div>
      <div className="bank-card-bottom">
        <span>{holder ?? "CLIENTE AIDO"}</span>
        <span className="bank-card-net" aria-hidden="true">
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
