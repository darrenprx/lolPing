import { useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/update';
import { api } from './api';

/** The update checker's state: undefined until the main process has answered, null when this build has no update checker. */
export function useUpdateState(): UpdateState | null | undefined {
  const [state, setState] = useState<UpdateState | null | undefined>(undefined);
  useEffect(() => {
    let pushed = false; // a pushed state is newer than a getUpdate() reply that arrives after it
    const off = api.onUpdate((s) => {
      pushed = true;
      setState(s);
    });
    void api.getUpdate().then((s) => {
      if (!pushed) setState(s);
    });
    return off;
  }, []);
  return state;
}
