// Database schema — the bot's conversation memory.
//
// One table keeps recent turns per chat, so the engine can send a short
// history with each request (stateless between invocations otherwise).

import { table, integer, text, sql } from 'sdk/db';

export const history = table('history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  role: text('role').notNull(),        // 'user' | 'assistant'
  content: text('content').notNull(),
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

export const MAX_ROWS_PER_CHAT = 60; // prune target (soft cap)
