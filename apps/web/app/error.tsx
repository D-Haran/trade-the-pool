'use client';

import { ErrorState } from '@/components/ui/states';

export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="page content-width">
      <ErrorState
        title="This area could not be rendered"
        detail="A recoverable application error occurred."
        retry={reset}
      />
    </div>
  );
}
