export const runtimeConfig = {
  "mode": "api",
  "activeModelId": "mercury-3",
  "providers": [
    {
      "id": "inception",
      "name": "Inception",
      "baseUrl": "https://api.inceptionlabs.ai/v1",
      "enabled": true,
      "keys": [
        {
          "id": "kpmd8gzkw",
          "value": "sk-test"
        }
      ]
    }
  ],
  "models": [],
  "settings": {
    "showThinking": true,
    "thinkingPreviewChars": 400,
    "maxHistoryTurns": 12,
    "allowGroups": true,
    "defaultSystemPrompt": "You are a helpful assistant in a Telegram chat. Answer concisely.",
    "defaultModelId": "mercury-3"
  },
  "reportUrl": "",
  "reportSecret": "sek",
  "configEpoch": 1
};
