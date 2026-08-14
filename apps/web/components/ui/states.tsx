import { AlertTriangle, Inbox, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from './button';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state-block" role="status">
      <LoaderCircle className="animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-block state-block--large">
      <Inbox aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function ErrorState({
  title = 'Unable to load',
  detail = 'The service did not return a usable response.',
  retry,
}: {
  title?: string;
  detail?: string;
  retry?: () => void;
}) {
  return (
    <div className="state-block state-block--large" role="alert">
      <AlertTriangle aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
      {retry ? (
        <Button variant="secondary" size="sm" onClick={retry}>
          <RotateCcw size={14} aria-hidden="true" /> Retry
        </Button>
      ) : null}
    </div>
  );
}
