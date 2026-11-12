/// <reference types="vite/client" />

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: Record<string, unknown>;
  ready?: () => void;
  expand?: () => void;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
