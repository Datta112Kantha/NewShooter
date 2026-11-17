'use strict';

const { createServer } = require('./src/server/app');

async function main() {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const app = createServer({
    port,
    headless: process.env.HEADLESS === '1'
  });

  const addr = await app.start(port, host);
  console.log(`Bin4ry Relay (Self-Hosted) listening on http://${addr.address}:${addr.port}`);
  console.log(`WebSocket Agent & Dashboard Hub active at ws://${addr.address}:${addr.port}`);

  const shutdown = async () => {
    console.log('\nShutting down NewShooter controller...');
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { createServer };
