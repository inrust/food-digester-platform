import type { ReactNode } from 'react';

export function FilterBar({
  children,
  actions,
  feedback,
  testId,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly feedback?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div className="filter-bar filter-bar--stacked" data-testid={testId}>
      <div className="filter-fields">{children}</div>
      {actions !== undefined ? <div className="filter-actions">{actions}</div> : null}
      {feedback}
    </div>
  );
}
