import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
export const reports=sqliteTable('reports',{key:text('key').primaryKey(),payload:text('payload').notNull(),receivedAt:integer('received_at').notNull()});
export const history=sqliteTable('gpu_history',{key:text('key').primaryKey(),node:text('node').notNull(),minute:integer('minute').notNull(),utilization:real('utilization'),gpuCount:integer('gpu_count').notNull() },table=>[index('idx_gpu_history_minute').on(table.minute)]);
