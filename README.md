# Disclaimer

This is purely AI generated as a companion piece to Cyberpunk 2077 roleplay or other themed pieces.

Model and interface used: Claude Opus 5.5 in Desktop App with Max effort. Execution time - 52 minutes.

# Blackwire

Phone-to-phone payments for a cyberpunk role-play. Every player gets an account in their phone's browser,
pays by scanning a QR code, and sees money arrive the moment it is sent. The game master runs everything
from a console page.

One server can host many separate games ("lobbies"), and anyone can register to run their own.
It runs on a laptop for a single event or on a web server for everyone.

It is a game prop, not a bank: the money is made up.

**Live at [credits.arcade.lv](https://credits.arcade.lv).** Anyone can register there and run a game.

## Start it

Needs [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
node server.js
```

The terminal prints the address of the lobby hub, the master password, and the address of each lobby.
Stopping the server (Ctrl+C) keeps all accounts and balances.

| Option | Example | What it does |
| --- | --- | --- |
| `--port` | `node server.js --port 8080` | Port to listen on (default 3250). |
| `--host` | `node server.js --host 127.0.0.1` | Listen on this machine only. |
| `--data` | `node server.js --data D:\game` | Where the data is kept (default `data/`). |
| `ADMIN_PASSWORD` | environment variable | Use your own master password instead of the generated one. |

## Getting phones connected

### Same Wi-Fi

Put the laptop and the phones on the same Wi-Fi and have players open the address from the terminal,
or scan the join code from the GM console.

- The first time, Windows asks whether Node may accept connections. Allow it for private networks,
  otherwise phones cannot reach the laptop.
- Keep the laptop awake and plugged in for the whole game.
- Phone browsers only allow in-page camera access over https, and this address is plain http.
  Players can still pay by pointing their phone's own camera app at a pay code (it is an ordinary link
  and opens the payment), with the "Photograph the code" button, or by picking the payee from the list.

### Https tunnel

A tunnel gives the server a public https address. The in-app scanner then works, and phones can be on
mobile data instead of the venue Wi-Fi. The laptop needs internet access.

1. Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. With the server running, start a tunnel in a second terminal:

   ```bash
   cloudflared tunnel --url http://localhost:3250
   ```

3. It prints an address ending in `trycloudflare.com`. Paste it into **Players join at** in the GM console,
   so join codes, access cards and pay signs carry that address.

Things to know about these free [quick tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

- The address changes every time the tunnel is restarted. Printed cards and signs carry the address,
  so print them after the tunnel is up and leave it running.
- Cloudflare offers them for testing, without an uptime guarantee. Try it at the venue beforehand and
  keep the Wi-Fi address as a fallback.
- A tunnel carries at most 200 requests at once and every open phone holds one, so it suits a few
  dozen players, not hundreds.

For an address that never changes, use a named tunnel with a Cloudflare account, or run the server on a
host that provides https.

### Public web server

This is how [credits.arcade.lv](https://credits.arcade.lv) runs: on a server behind its web server's https
(CloudPanel's nginx, with Cloudflare in front), listening on this machine only on the default port 3250,
and kept running by pm2:

```bash
ADMIN_PASSWORD='choose-your-own' pm2 start server.js --name credits -- --host 127.0.0.1
```

To update it, pull and restart:

```bash
git pull && pm2 restart credits
```

The proxy must pass every path through, including `/api/`, and allow requests to stay open for at
least 30 seconds. Registration for organizers is open by default: on a public address, consider an
invite code or switching it off (see [The server owner](#the-server-owner)).

## Players

- **Join**: open the address, choose a handle and a PIN. Or scan an access card made by the GM.
- **Pay**: *Scan to pay* and point at someone's code, or *Send* and pick them from the list.
- **Get paid**: *Receive* shows your code. *Request a set amount* puts the price and a note into the
  code, so the payer only has to confirm.
- Incoming money shows up at once with a sound, and the balance updates by itself.

## Lobbies

One server can host several separate games at once, or keep a set-up game around to run again.
Each lobby has its own address (`/night-city`, for example), players, money, ledger, settings, theme
and GM password. Players logged into one lobby see nothing of the others, and one phone can be in
several lobbies at the same time.

## Organizers

Anyone can run their own game. `/admin` is the **game hub**, and every lobby's login screen links to it
("Run your own role-play? Make a credits lobby"). There, people register an organizer account with a
name and a password, then create and run their own lobbies. Organizers only ever see their own lobbies.

In the hub, an organizer can:

- **New lobby**: give it a name, an address and a theme. It can start empty, copy another of their
  lobbies' settings, or also copy its cast (same handles, fresh balances, PINs and access cards).
- **Open console** for a lobby, rename it, see its GM password, or delete it.

A lobby's GM password opens only that lobby's console, so an organizer can hand it to a co-GM.
It can be changed in that console's Settings.

## The server owner

Log in to `/admin` with **Server owner** and the master password from the terminal. You see every
lobby (with who made it) and can open any console, plus:

- **Organizers**: disable, re-enable or delete accounts, and reset a forgotten password (there is no
  e-mail, so this is the only way back in). Deleting an organizer removes their lobbies too.
- **Registration**: switch self-registration off, require an invite code, and set how many lobbies each
  organizer may have (5 by default; yours are unlimited).
- **Make default**: the bare server address, and links printed before lobbies existed, lead to this
  lobby. Your first lobby becomes the default automatically; an organizer's lobby only does if you
  choose it.

Deleted lobbies are moved to `data/deleted/`, not erased.

## Themes

Each lobby picks a theme in its console's Settings; players' phones switch to it straight away.

- **Blackwire**: acid yellow on black (the original look).
- **Neon**: synthwave magenta and cyan.
- **Toxic**: green phosphor terminal, monospaced.
- **Corpo**: clean, light and corporate, without scanlines.

## Game master

Open the lobby's console at `/<lobby>/admin` (or from the hub) and enter its GM password.

- **Accounts**: create accounts one by one or paste a whole cast list, add or remove funds, freeze,
  rename, clear a PIN, delete. Each account has a printable access card (logs a phone in) and a pay
  sign (for a shop counter or clinic door).
- **Pay or charge all**: paydays, rent, taxes.
- **Ledger**: every transaction live, with one-click reversal and CSV export.
- **Settings**: bank name, currency symbol, starting balance, whether players may sign up themselves,
  an optional join code, whether players can see the full directory, the theme, and the console password.

## Data

Each lobby lives in `data/lobbies/<lobby>/db.json`, with a copy saved to `backups/` next to it on
every start and before a wipe (the ten newest are kept). To restore one, stop the server and copy it
over that lobby's `db.json`. Lobbies, organizers and the master password are in `data/hub.json`.

Upgrading from the version without lobbies needs nothing: on first start the old `data/db.json`
becomes the lobby `main`, its GM password becomes the master password, phones stay logged in, and
old QR codes keep working because they lead to the default lobby.

## Tests

```bash
npm test
```

## Credits

Bundled so the app works without internet access:
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT),
[qr-scanner](https://github.com/nimiq/qr-scanner) (MIT), and the fonts Chakra Petch and Share Tech Mono
(SIL Open Font License). Their licence notices are kept in or next to the files in `public/vendor` and
`public/fonts`.
