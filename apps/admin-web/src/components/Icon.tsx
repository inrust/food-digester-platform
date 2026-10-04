/** Small, local vector icon set; decorative icons never replace accessible labels. */
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  device: 'M4 3h16v14H4z M8 21h8 M12 17v4 M8 7h8 M8 11h5',
  leaf: 'M20 4C9 2 3 8 5 15c2 7 14 5 15-11Z M5 20l10-10 M10 15v-5',
  file: 'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h6',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  users: 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M2 21v-3a7 7 0 0 1 14 0v3 M17 4a4 4 0 0 1 0 8 M20 21v-3a6 6 0 0 0-3-5',
  pin: 'M12 22s8-8 8-14a8 8 0 0 0-16 0c0 6 8 14 8 14Z M12 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z M8 12l3 3 5-6',
  bell: 'M18 8a6 6 0 0 0-12 0v5l-3 4h18l-3-4Z M10 21h4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  cloud: 'M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11Z',
};
export function Icon({ name, className = '' }: { name: string; className?: string }) {
  return (
    <svg
      className={`ui-icon ${className}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}
export function pageIcon(state: string): string {
  if (state.startsWith('esg')) return 'leaf';
  if (state.includes('contract') || state === 'licenses') return 'file';
  if (state.includes('users') || state === 'customers') return 'users';
  if (state === 'settings' || state === 'configurations') return 'settings';
  if (state === 'sites') return 'pin';
  if (state === 'audit-logs') return 'shield';
  if (state === 'alarms') return 'bell';
  return state === 'dashboard' ? 'grid' : 'device';
}
