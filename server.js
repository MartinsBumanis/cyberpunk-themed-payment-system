import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from './lib/hub.js';
import { createApp } from './lib/app.js';

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const port = Number(flag('port', process.env.PORT ?? 3250));
const host = flag('host', process.env.HOST ?? '0.0.0.0');
const dataDir = path.resolve(flag('data', process.env.DATA_DIR ?? fileURLToPath(new URL('./data', import.meta.url))));
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

let hub;
try {
  hub = new Hub({ dir: dataDir, password: process.env.ADMIN_PASSWORD });
} catch (err) {
  console.error(`\n  Could not read the data in ${dataDir}: ${err.message}`);
  console.error('  Nothing was changed. Each lobby keeps backups in data/lobbies/<lobby>/backups: copy the newest');
  console.error("  over that lobby's db.json, or move the damaged file aside to start that lobby empty.\n");
  process.exit(1);
}

const server = createApp(hub, { lanUrls });

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `\n  Port ${port} is already in use. Stop the other program or start with: node server.js --port 3251\n`
    : err);
  process.exit(1);
});

server.listen(port, host, () => {
  const local = `http://localhost${port === 80 ? '' : `:${port}`}`;
  const [first = local, ...others] = lanUrls();
  const lobbies = hub.list({ master: true });
  console.log(`\n  Payment grid online with ${lobbies.length} ${lobbies.length === 1 ? 'lobby' : 'lobbies'}.\n`);
  console.log(`  Front page       ${first}`);
  console.log(`  Game hub         ${local}/admin`);
  console.log(`  Master password  ${hub.password}`);
  for (const { slug, title, isDefault } of lobbies) {
    console.log(`  ${isDefault ? 'Default lobby' : 'Lobby        '}    ${first}/${slug}  (${title})`);
  }
  for (const url of others) console.log(`  Also reachable   ${url}`);
  console.log(`  Data             ${dataDir}\n`);
  console.log(localOnly
    ? `  Listening on this machine only (--host ${host}). Phones cannot connect.`
    : '  Phones must be on the same network as this machine.');
  console.log('  Ctrl+C stops the server. Accounts and balances are kept.\n');
});

// 'exit' also runs after a crash, so the latest balances always reach the disk.
process.on('exit', () => hub.flushSync());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
