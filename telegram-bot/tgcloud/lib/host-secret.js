// Where the bot finds the control plane, and how it proves who it is.
//
// reportUrl    your Cloudflare Pages URL, e.g. https://inception-panel.pages.dev
// reportSecret the same BOT_REPORT_SECRET you set on Cloudflare
//
// These stay EMPTY in git on purpose. This repository is public, and
// reportSecret can read /api/runtime-config, which hands back real API keys.
// Fill them locally — never commit the filled-in version:
//
//   export BOT_REPORT_SECRET=...
//   node scripts/set-host-secret.mjs https://inception-panel.pages.dev
//
// The Termux deploy script does this for you before `npx tgcloud push`.
// Empty values are harmless: the bot just runs on its embedded config and
// reports that no model provider is configured yet.

export const hostSecret = {
  reportUrl: '',
  reportSecret: '',
};
