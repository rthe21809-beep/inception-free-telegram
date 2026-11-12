export const runtimeConfig = {
  "mode": "api",
  "activeModelId": "mercury-3",
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "enabled": true,
      "keys": []
    }
  ],
  "models": [],
  "settings": {
    "showThinking": true,
    "thinkingPreviewChars": 400,
    "maxHistoryTurns": 20,
    "allowGroups": false,
    "defaultSystemPrompt": "You are a helpful assistant in a Telegram chat. Answer concisely.",
    "defaultModelId": "mercury-3"
  },
  "reportUrl": "",
  "reportSecret": "sek",
  "configEpoch": 5
};
