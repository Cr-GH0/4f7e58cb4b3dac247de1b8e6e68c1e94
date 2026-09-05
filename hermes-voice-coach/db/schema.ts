import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
// Immutable revisions also keep an active call on its original configuration.
export const hermesSettings = sqliteTable('hermes_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  config: text('config').notNull(),
  savedAt: text('saved_at').notNull(),
});
