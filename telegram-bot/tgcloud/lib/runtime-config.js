// Runtime config for the bot. The bot fetches the LIVE config from the panel
// host (reportUrl + reportSecret below) on each message and merges it over
// this file — so anything you change in the panel applies without redeploy.
//
// ONLY TWO FIELDS YOU MUST FILL IN (see DEPLOY.md Part 3):
//   reportUrl    -> your Cloudflare Pages URL, e.g. https://inception-panel.pages.dev
//   reportSecret -> the same BOT_REPORT_SECRET you set on Cloudflare
//
// providers/models/keys are managed in the panel — leave them empty here.
// NEVER put a real API key in this file (it is committed to git).

export const runtimeConfig = {
  mode: 'api',
  activeModelId: null,
  providers: [],
  models: [],
  settings: {
    showThinking: true,
    thinkingPreviewChars: 400,
    maxHistoryTurns: 12,
    allowGroups: true,
    defaultSystemPrompt: 'You are a helpful assistant in a Telegram chat. Answer concisely.',
    defaultModelId: null,
  },
  reportUrl: '',        // <-- fill: your Pages URL
  reportSecret: '',     // <-- fill: BOT_REPORT_SECRET
  configEpoch: 0,
};
