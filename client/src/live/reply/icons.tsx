// Inline icons for the policyholder check-in page (stroke = currentColor unless noted).
type P = { size?: number };
const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true });

export const ChevronLeft = ({ size = 22 }: P) => <svg {...base(size)}><path d="M15 5l-7 7 7 7" /></svg>;
export const ChevronRight = ({ size = 18 }: P) => <svg {...base(size)}><path d="M9 5l7 7-7 7" /></svg>;
export const More = ({ size = 22 }: P) => (
  <svg {...base(size)} stroke="none" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
);
export const ChatIcon = ({ size = 16 }: P) => <svg {...base(size)}><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9.5h8M8 12.5h5" /></svg>;
export const PhoneIcon = ({ size = 20 }: P) => (
  <svg {...base(size)}><path d="M6.6 3.5h2.6l1.4 4-2 1.3a12 12 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" /></svg>
);
export const Shield = ({ size = 16 }: P) => <svg {...base(size)}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>;
export const Doc = ({ size = 16 }: P) => <svg {...base(size)}><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /></svg>;
export const Camera = ({ size = 24 }: P) => <svg {...base(size)}><path d="M4 8h3l1.6-2.5h6.8L17 8h3v11H4z" /><circle cx="12" cy="13.2" r="3.6" /></svg>;
export const Pin = ({ size = 24 }: P) => <svg {...base(size)}><path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z" /><circle cx="12" cy="9.8" r="2.4" /></svg>;
export const ArrowUp = ({ size = 22 }: P) => <svg {...base(size)} strokeWidth={2.2}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
