// Telegram Serverless message handler.
//
// Telegram routes every new message to this module and calls the default
// export with the unwrapped Message object. Everything interesting lives in
// lib/engine.js (pure, testable); this file only wires the SDK in and
// guarantees the handler never dies on an unexpected error.

import { api, db } from 'sdk';
import { handleMessage } from '../lib/engine.js';
import { history } from '../schema.js';
import { eq, desc } from 'sdk/db';

async function getHistory(chatId, limit) {
  const rows = await db.select().from(history)
    .where(eq(history.chatId, chatId))
    .orderBy(desc(history.id))
    .limit(limit)
    .run();
  return (rows || []).map(r => ({ role: r.role, content: r.content }));
}

async function saveTurn(chatId, role, content) {
  await db.insert(history).values({ chatId, role, content }).run();
}

export default async function (message) {
  try {
    await handleMessage(message, { api, db, getHistory, saveTurn });
  } catch (err) {
    console.error('[message] unhandled error:', String(err?.stack || err).slice(0, 400));
    try {
      await api.sendMessage({
        chat_id: message?.chat?.id,
        text: '⚠️ Sorry, something broke on my side. Please try again.',
      });
    } catch { /* give up silently */ }
  }
}
