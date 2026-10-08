import type { Strings } from '../shared/i18n';
import type { Updater } from './updater';

export interface TrayUpdateDeps {
  updater: Pick<Updater, 'check' | 'startUpdate' | 'state'>;
  /** Shows a toast on the overlay. Does nothing once the app is quitting. */
  toast(title: string, body: string): void;
  text(): Strings;
}

/**
 * What the tray's update items do. The tray has no card to show a result on (the Settings buttons do), so each action reports how
 * it ended with a toast: "up to date" after a check that found nothing, and the error message after a check, download or install
 * that failed. A check that finds an update needs none (the new-version toast and the menu item say so). A call the updater ignored
 * (another check or a download was already running) leaves its state untouched and reports nothing.
 */
export function trayUpdateHandlers({ updater, toast, text }: TrayUpdateDeps): { check(): void; start(): void } {
  const fire = (action: () => Promise<void>): void => {
    action().catch((err: unknown) => console.error('[update] a tray action failed:', err)); // the updater never rejects; this is a backstop
  };
  return {
    check: () => fire(async () => {
      const before = updater.state;
      await updater.check(true);
      const after = updater.state;
      if (after === before) return;
      if (after.phase === 'idle') toast(text().upToDate, '');
      else if (after.phase === 'error') toast(text().updateErrorToastTitle, after.message);
    }),
    start: () => fire(async () => {
      const before = updater.state;
      await updater.startUpdate();
      const after = updater.state;
      // Success leaves 'installing' (the app is quitting), and an abort by quitting puts the state back to 'available': no toast.
      if (after !== before && after.phase === 'error') toast(text().updateErrorToastTitle, after.message);
    }),
  };
}
