// ---------------------------------------------------------------------------
// CANCELLABLE-SCAN UI WRAPPER
//
// Shared by every view whose scan emits scan:progress (Smart Scan, System Junk,
// Large Files). While `start()` runs, the trigger button turns into "Cancel" —
// clicking it again aborts the main-process scan — and `progressEl` shows live
// {phase, done, total} updates. Resolves with the scan result; a user cancel
// resolves to null (the main process maps AbortError to null). The cancel click
// itself resolves to undefined so callers can tell the two apart and only
// announce "cancelled" once.
// ---------------------------------------------------------------------------
import { api } from './api.js';

export async function runCancellableScan(btn, progressEl, start) {
  if (btn.dataset.scanning) { api.cancelScan(); return undefined; } // second click = cancel
  btn.dataset.scanning = '1';
  const prevLabel = btn.textContent;
  btn.textContent = 'Cancel';
  progressEl.hidden = false;
  progressEl.textContent = 'Scanning…';
  const off = api.onScanProgress(({ phase, done, total }) => {
    progressEl.textContent = `Scanning ${done}/${total} — ${phase}`;
  });
  try {
    return await start();
  } finally {
    off();
    delete btn.dataset.scanning;
    btn.textContent = prevLabel;
    progressEl.hidden = true;
  }
}
