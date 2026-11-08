// One cell status, three states, used everywhere a cell's status is shown.
//   Inspected   – an adjuster filed at least one field report here.
//   Confident   – nobody has been there, but the model is confident from hazard / SMS / claims.
//   Needs check – the model is not confident (or the area is silent with high hazard).
export type CellStatus = 'inspected' | 'confident' | 'needs_check';

export const CELL_STATUS_LABEL: Record<CellStatus, string> = {
  inspected: 'Inspected',
  confident: 'Confident',
  needs_check: 'Needs check',
};

export function cellStatus(fieldReports: number, verification: 'verified' | 'needs_verification'): CellStatus {
  if (fieldReports > 0) return 'inspected';
  return verification === 'verified' ? 'confident' : 'needs_check';
}
