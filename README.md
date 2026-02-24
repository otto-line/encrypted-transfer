# Encrypted Transfer

Encrypted file transfer that runs on your own hardware. Files are encrypted entirely in the browser before leaving the sender's machine — only ciphertext crosses the wire. The server (which you own and control) decrypts using its private key and saves files to disk.

Designed to run locally on a Raspberry Pi (or any computer) and be exposed to the public internet through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). Because the files are end-to-end encrypted, it is safe to route them through a third party — only the server owner (the recipient) can access the unencrypted files.

## Tech Stack

| Layer    | Technology                                                                 |
| -------- | -------------------------------------------------------------------------- |
| Frontend | Vanilla HTML / JS — no framework, no build step                           |
| Backend  | Express 4 on Node.js, written in TypeScript, run via `tsx` in development |
| Crypto   | Browser [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) + Node.js built-in `crypto` module — zero third-party crypto libraries |
| Monorepo | npm workspaces (`packages/backend`, `packages/frontend`)                  |

## Getting Started

```bash
# Install dependencies
npm install

# Start the dev server (Express + static frontend)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For production:

```bash
npm run build
npm start
```

## Project Structure

```
encrypted-transfer/
├── packages/
│   ├── backend/
│   │   └── src/server.ts      ← Express server, RSA key pair, decryption logic
│   └── frontend/
│       └── public/
│           ├── index.html     ← Upload UI, client-side encryption
│           └── about.html     ← Encryption explainer page
└── uploads/                   ← Decrypted files saved here at runtime
```

## How the Encryption Works

The app uses **hybrid encryption** — the same pattern behind TLS, PGP, and S/MIME. A fast symmetric cipher encrypts the file, and a slow asymmetric cipher protects the symmetric key.

### Layer 1 — RSA-2048 / OAEP / SHA-256 (asymmetric)

When the server starts it generates an **ephemeral RSA-2048 key pair** in memory (SPKI/PEM public, PKCS#8/PEM private). The keys are not persisted — they are regenerated on every restart.

The public key is served to the browser via `GET /api/public-key`. The private key never leaves the server process.

### Layer 2 — AES-256-GCM (symmetric)

For each upload the browser generates:

- A **random 256-bit AES key** (32 bytes) via `crypto.subtle.generateKey`
- A **random 96-bit IV** (12 bytes) via `crypto.getRandomValues` (NIST-recommended size for GCM)

The file is encrypted with AES-256-GCM, which provides both confidentiality and integrity. Web Crypto appends a 16-byte authentication tag to the ciphertext — any tampering will cause decryption to fail.

### End-to-End Flow

```
BROWSER                                          SERVER
──────                                           ──────
                                          Generate RSA-2048 key pair

GET /api/public-key ──────────────────►   Return public key (PEM)
Import as RSA-OAEP/SHA-256 CryptoKey

User selects a file
Read file → ArrayBuffer
Generate random AES-256 key (32 bytes)
Generate random IV (12 bytes)
AES-GCM encrypt(file) → ciphertext+tag
RSA-OAEP encrypt(AES key) → 256 bytes
Base64-encode everything

POST /api/upload ─────────────────────►   RSA-OAEP decrypt → recover AES key
                                          Split ciphertext / auth tag
                                          AES-GCM decrypt → recover file
                                          Save to uploads/
                                     ◄─   { success, filename, bytes }
```

### JSON Payload Format

The encrypted payload is sent as a JSON POST body with four fields:

| Field             | Contents                                  | Size              |
| ----------------- | ----------------------------------------- | ----------------- |
| `encryptedAesKey` | RSA-OAEP ciphertext of the AES key       | 256 bytes         |
| `encryptedFile`   | AES-GCM ciphertext + 16-byte auth tag    | file size + 16 B  |
| `iv`              | AES-GCM initialisation vector             | 12 bytes          |
| `filename`        | Original filename (plaintext)             | varies            |

All binary fields are base64-encoded for JSON transport.

### Server-Side Decryption

1. Base64-decode all fields
2. RSA-OAEP decrypt the AES key using the private key (`RSA_PKCS1_OAEP_PADDING`, `oaepHash: "sha256"`)
3. Split the encrypted file into ciphertext and the trailing 16-byte GCM auth tag (Node's `crypto` module requires the tag separately via `setAuthTag()`, unlike Web Crypto which concatenates it)
4. AES-256-GCM decrypt the ciphertext, verifying the auth tag
5. Save the recovered plaintext to `uploads/<filename>`

## Deployment with Cloudflare Tunnel

The recommended setup is to run the server on your own machine (e.g. a Raspberry Pi) and use a persistent Cloudflare Tunnel to make it reachable from the public internet over HTTPS. Because the files are end-to-end encrypted before they leave the sender's browser, routing through Cloudflare does not compromise confidentiality — Cloudflare only ever sees ciphertext.

### Step 1 — Install `cloudflared`

```bash
brew install cloudflare/cloudflare/cloudflared
```

### Step 2 — Start the Express server

```bash
npm run dev
# listening on http://localhost:3000
```

### Step 3 — Quick tunnel (no account needed)

```bash
cloudflared tunnel --url http://localhost:3000
```

Within a few seconds it prints something like:

```
Your quick Tunnel has been created! Visit it at:
https://something-random-words.trycloudflare.com
```

That URL is live, HTTPS, and works from anywhere. Share it and the app works immediately.

**Limitation:** the URL is random and changes every time you restart. Fine for testing, not for a permanent installation.

### Step 4 — Named tunnel (stable URL)

This requires:

- A free Cloudflare account at [cloudflare.com](https://cloudflare.com)
- A domain whose DNS is managed by Cloudflare (you can transfer an existing domain, buy one through Cloudflare, or use a cheap one from Namecheap/Porkbun and point its nameservers at Cloudflare)

Once you have that:

```bash
# Authenticate — opens a browser to log in to your Cloudflare account
cloudflared tunnel login

# Create a named tunnel (do this once)
cloudflared tunnel create encrypted-transfer
# This writes a credentials file to ~/.cloudflared/<tunnel-id>.json
# Note the tunnel ID printed in the output
```

Add a config file:

```bash
mkdir -p packages/backend/tunnel
```

Create `packages/backend/tunnel/config.yml`:

```yaml
tunnel: <your-tunnel-id-here>
credentials-file: /home/pi/.cloudflared/<your-tunnel-id-here>.json  # adjust path per machine

ingress:
  - hostname: yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Add a DNS route (once per domain):

```bash
cloudflared tunnel route dns encrypted-transfer yourdomain.com
```

Run the named tunnel:

```bash
cloudflared tunnel --config packages/backend/tunnel/config.yml run
```

### Step 5 — Run as a service on the Raspberry Pi (always-on)

On the Pi, after copying the credentials file and config:

```bash
# Install cloudflared as a systemd service (handles reboots, restarts on crash)
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

You'll also want the Express app running as a service. A simple option is [pm2](https://pm2.keymetrics.io/) or a systemd unit:

```bash
# With pm2
npm run build
pm2 start npm --name encrypted-transfer -- start
pm2 save
pm2 startup
```

## Security Notes

- **No plaintext on the wire** — only the RSA-encrypted AES key and AES-GCM ciphertext are transmitted.
- **Authenticated encryption** — GCM provides both confidentiality and integrity; tampering is detected at `decipher.final()`.
- **Fresh keys per upload** — a new AES key and IV are generated for every file. The RSA pair is regenerated on every server restart.
- **Safe to proxy through Cloudflare** — the tunnel sees only encrypted payloads. Decryption requires the server's private key, which never leaves the machine.
- **Filename is unencrypted** — it is the only piece of metadata sent in plaintext.
- **HTTPS via Cloudflare** — the tunnel provides TLS termination at Cloudflare's edge, so browsers see a valid HTTPS certificate. The local segment (Cloudflare → localhost) stays on the same machine.
- **~75 MB file limit** — the Express JSON body parser is capped at 100 MB; base64 overhead (~33%) gives a practical ceiling of roughly 75 MB.
