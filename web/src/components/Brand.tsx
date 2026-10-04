/** AIDO mark: an "A" whose crossbar is a speech tail — banking that talks back. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="aido-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-2)" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#aido-g)" />
      <path d="M11 29 20 10l9 19" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.6 22.5h10.8l-2.6 3.6" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 32, sub }: { size?: number; sub?: string }) {
  return (
    <span className="wordmark">
      <Logo size={size} />
      <span className="wordmark-text">
        <span className="wordmark-name">AIDO</span>
        {sub && <span className="wordmark-sub">{sub}</span>}
      </span>
    </span>
  );
}

export function Avatar({ who }: { who: "assistant" | "agent" }) {
  return who === "assistant" ? (
    <span className="avatar assistant" aria-hidden="true">
      <Logo size={30} />
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
