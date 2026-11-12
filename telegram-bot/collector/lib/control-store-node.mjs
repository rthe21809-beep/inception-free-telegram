// Node-only persistence for ControlState (JSON file). The Worker/Pages
// variant uses a KV namespace instead — see admin-panel/functions/.

import fs from 'node:fs';
import { ControlState } from './control-state.mjs';

export function loadControlStateFile(file) {
  let initial = null;
  try {
    if (file && fs.existsSync(file)) initial = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[control-state] load failed:', String(e?.message || e).slice(0, 150));
  }
  const persist = (state) => {
    try { fs.writeFileSync(file, JSON.stringify(state, null, 2)); }
    catch (e) { console.error('[control-state] save failed:', String(e?.message || e).slice(0, 150)); }
  };
  return ControlState.fromObject(initial, { persist });
}
