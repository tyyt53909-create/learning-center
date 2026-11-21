import { resolve } from 'node:path';
import { createApplication } from './app.js';

const host = process.env.HOST || '127.0.0.1';
const token = process.env.ACCESS_TOKEN;
if (!['127.0.0.1', '::1'].includes(host) && !token) throw new Error('监听非 loopback 地址前请设置 ACCESS_TOKEN');
const port = Number(process.env.PORT || 3000);
const service = await createApplication({
  dataDir: resolve(process.env.DATA_DIR || '.data'), databaseUrl: process.env.DATABASE_URL, token,
  pollEvents: Boolean(process.env.DATABASE_URL),
  ai: {
    key: process.env.AI_API_KEY, model: process.env.AI_MODEL, base: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    embeddingModel: process.env.AI_EMBEDDING_MODEL,
    embeddingKey: process.env.AI_EMBEDDING_API_KEY,
    embeddingBase: process.env.AI_EMBEDDING_BASE_URL,
    searchProvider: process.env.AI_SEARCH_PROVIDER || 'duckduckgo',
    searchKey: process.env.AI_SEARCH_API_KEY || '',
    searchBase: process.env.AI_SEARCH_BASE_URL || '',
  },
});
const server = service.app.listen(port, host, () => {
  const address = host === '::1' ? '[::1]' : host;
  console.log(`学习中心 · http://${address}:${server.address().port}`);
});
server.on('error', async (error) => {
  console.error(error.message);
  await service.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close();
  await service.close();
});
