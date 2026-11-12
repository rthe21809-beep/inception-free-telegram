// Runtime config for the bot. The bot fetches the LIVE config from the panel
// host (reportUrl + reportSecret below) on each message and merges it over
// this file — so anything you change in the panel applies without redeploy.
//
// providers/models/keys are managed in the panel — leave them empty here.
// NEVER put a real API key in this file (it is committed to git).
//
// The panel URL + shared secret do NOT live here: this repository is public,
// and that secret can read real API keys. They come from ./host-secret.js,
// which stays empty in git and is filled by the deploy step.

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
  configEpoch: 0,
};
