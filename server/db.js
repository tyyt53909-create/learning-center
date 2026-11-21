import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';

export async function openDatabase(dataDir, connectionString) {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (!connectionString) {
    const db = await PGlite.create(dataDir, { extensions: { vector } });
    await db.exec(schema);
    return db;
  }
  const pool = new pg.Pool({ connectionString });
  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(8190301)');
    await client.query(schema);
  });
  return { query: pool.query.bind(pool), transaction: tx, close: pool.end.bind(pool) };
}
