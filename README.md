# Disclaimer

This is purely AI generated as a companion piece to Cyberpunk 2077 roleplay or other themed pieces.

Model and interface used: Claude Opus 5.5 in Desktop App with Max effort. Execution time - 52 minutes.

# Blackwire

Phone-to-phone payments for a cyberpunk role-play. Every player gets an account in their phone's browser,
pays by scanning a QR code, and sees money arrive the moment it is sent. The game master runs everything
from a console page.

It is a game prop, not a bank: the money is made up and the server runs on your laptop.

## Start it

Needs [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
node server.js
```

The terminal prints the address for players, the address of the GM console, and the GM password.
Stopping the server (Ctrl+C) keeps all accounts and balances.

| Option | Example | What it does |
| --- | --- | --- |
| `--port` | `node server.js --port 8080` | Port to listen on (default 3000). |
| `--host` | `node server.js --host 127.0.0.1` | Listen on this machine only. |
| `--data` | `node server.js --data D:\game` | Where the data is kept (default `data/`). |
| `ADMIN_PASSWORD` | environment variable | Use your own GM password instead of the generated one. |

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
   cloudflared tunnel --url http://localhost:3000
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

## Players

- **Join**: open the address, choose a handle and a PIN. Or scan an access card made by the GM.
- **Pay**: *Scan to pay* and point at someone's code, or *Send* and pick them from the list.
- **Get paid**: *Receive* shows your code. *Request a set amount* puts the price and a note into the
  code, so the payer only has to confirm.
- Incoming money shows up at once with a sound, and the balance updates by itself.

## Game master

Open `/admin` on the server's address and enter the password from the terminal.

- **Accounts**: create accounts one by one or paste a whole cast list, add or remove funds, freeze,
  rename, clear a PIN, delete. Each account has a printable access card (logs a phone in) and a pay
  sign (for a shop counter or clinic door).
- **Pay or charge all**: paydays, rent, taxes.
- **Ledger**: every transaction live, with one-click reversal and CSV export.
- **Settings**: bank name, currency symbol, starting balance, whether players may sign up themselves,
  an optional join code, and whether players can see the full directory.

## Data

Everything lives in `data/db.json`. A copy is saved to `data/backups/` on every start and before a
wipe (the ten newest are kept). To restore one, stop the server and copy it over `db.json`.

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
