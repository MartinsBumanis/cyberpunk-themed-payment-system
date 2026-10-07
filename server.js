import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bank } from './lib/bank.js';
import { createApp } from './lib/app.js';

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const port = Number(flag('port', process.env.PORT ?? 3000));
const host = flag('host', process.env.HOST ?? '0.0.0.0');
const dataDir = path.resolve(flag('data', process.env.DATA_DIR ?? fileURLToPath(new URL('./data', import.meta.url))));
const dbFile = path.join(dataDir, 'db.json');
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);

// Addresses phones on the same network can use, likeliest first: real Wi-Fi/Ethernet before virtual adapters.
// Empty when the server only listens on this machine, because then no phone can reach it.
function lanUrls() {
  if (localOnly) return [];
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue;
      const virtual = /vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|bluetooth|tailscale|zerotier/i.test(name);
      found.push({ url: `http://${address.address}${port === 80 ? '' : `:${port}`}`, virtual });
    }
  }
  return found.sort((a, b) => a.virtual - b.virtual).map((entry) => entry.url);
}

let bank;
try {
  bank = new Bank({ file: dbFile, adminPassword: process.env.ADMIN_PASSWORD });
} catch (err) {
  console.error(`\n  Could not read ${dbFile}: ${err.message}`);
  console.error(`  Nothing was changed. To recover, copy the newest file from ${path.join(dataDir, 'backups')}`);
  console.error('  over db.json, or move db.json aside to start with an empty bank.\n');
  process.exit(1);
}

const server = createApp(bank, { lanUrls });

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `\n  Port ${port} is already in use. Stop the other program or start with: node server.js --port 3001\n`
    : err);
  process.exit(1);
});

server.listen(port, host, () => {
  const local = `http://localhost${port === 80 ? '' : `:${port}`}`;
  const [first = local, ...others] = lanUrls();
  console.log(`\n  ${bank.settings.bankName} is online.\n`);
  console.log(`  Players       ${first}`);
  for (const url of others) console.log(`                ${url}`);
  console.log(`  GM console    ${local}/admin`);
  console.log(`  GM password   ${bank.adminPassword}`);
  console.log(`  Data          ${dataDir}\n`);
  console.log(localOnly
    ? `  Listening on this machine only (--host ${host}). Phones cannot connect.`
    : '  Phones must be on the same network as this machine.');
  console.log('  Ctrl+C stops the server. Accounts and balances are kept.\n');
});

// 'exit' also runs after a crash, so the latest balances always reach the disk.
process.on('exit', () => bank.flushSync());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
