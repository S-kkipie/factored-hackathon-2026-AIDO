import { useId } from "react";

/**
 * AIDO mark: a speech bubble (conversation) holding a gold four-point spark (assistance), on a deep emerald
 * squircle. Ported from the design reference's src/components/Brand.tsx. Reads at 16px (favicon) and scales
 * up for the header.
 */
export function Logo({ size = 32 }: { size?: number }) {
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
      <rect width="48" height="48" rx="14" fill={`url(#${id}-bg)`} />
      <path
        d="M24 10.5c8.3 0 14.5 5.7 14.5 12.9S32.3 36.3 24 36.3c-1.6 0-3.1-.2-4.5-.6l-6.6 3.4 1.6-6.2c-2.9-2.3-4.9-5.7-4.9-9.5 0-7.2 6.1-12.9 14.4-12.9Z"
        fill="none"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path d="M24 16.2c.6 3.9 2.3 5.7 6.4 7.1-4.1 1.4-5.8 3.2-6.4 7.1-.6-3.9-2.3-5.7-6.4-7.1 4.1-1.4 5.8-3.2 6.4-7.1Z" fill={`url(#${id}-gold)`} />
    </svg>
  );
}

/** Lowercase wordmark; the dot of the "i" is the brand's gold spark. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} />
      <span className="wordmark-name" style={{ fontSize: Math.round(size * 0.62) }}>
        a<span className="wm-i">ı<span className="wm-dot" /></span>do
      </span>
    </span>
  );
}
