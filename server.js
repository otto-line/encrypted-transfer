const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// RSA-2048 key pair — generated fresh each server start
// ---------------------------------------------------------------------------
console.log("[server] Generating RSA-2048 key pair...");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
console.log("[server] RSA-2048 key pair ready.");

// ---------------------------------------------------------------------------
// Uploads directory
// ---------------------------------------------------------------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`[server] Created uploads directory: ${uploadsDir}`);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: "100mb" }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Return the server's RSA public key so the browser can encrypt with it. */
app.get("/api/public-key", (_req, res) => {
  res.json({ publicKey });
});

/**
 * Receive an encrypted image upload.
 *
 * Body (JSON):
 *   encryptedAesKey  — RSA-OAEP(SHA-256) encrypted 32-byte AES key (base64)
 *   encryptedFile    — AES-256-GCM ciphertext + 16-byte auth tag (base64)
 *   iv               — 12-byte GCM IV (base64)
 *   filename         — original filename
 *   mimeType         — original MIME type (e.g. "image/jpeg")
 */
app.post("/api/upload", (req, res) => {
  try {
    const { encryptedAesKey, encryptedFile, iv, filename, mimeType } = req.body;

    if (!encryptedAesKey || !encryptedFile || !iv || !filename) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Validate it's an image
    const allowedMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return res.status(400).json({ error: "Only image files are accepted." });
    }

    console.log(`\n[server] Incoming encrypted image: "${filename}"`);

    // 1. Decode base64 inputs
    const encryptedAesKeyBuf = Buffer.from(encryptedAesKey, "base64");
    const encryptedFileBuf   = Buffer.from(encryptedFile, "base64");
    const ivBuf              = Buffer.from(iv, "base64");

    // 2. Decrypt AES session key with RSA private key
    const aesKeyBuf = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      encryptedAesKeyBuf
    );
    console.log(`[server] AES session key decrypted (${aesKeyBuf.length * 8}-bit).`);

    // 3. Split WebCrypto-appended GCM auth tag (last 16 bytes)
    const GCM_TAG_LENGTH = 16;
    const ciphertext = encryptedFileBuf.subarray(0, encryptedFileBuf.length - GCM_TAG_LENGTH);
    const authTag    = encryptedFileBuf.subarray(encryptedFileBuf.length - GCM_TAG_LENGTH);

    // 4. Decrypt file with AES-256-GCM
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKeyBuf, ivBuf);
    decipher.setAuthTag(authTag);
    const decryptedData = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    console.log(`[server] Image decrypted: ${decryptedData.length} bytes.`);

    // 5. Save decrypted image
    const safeFilename = path.basename(filename);
    const outputPath = path.join(uploadsDir, safeFilename);
    fs.writeFileSync(outputPath, decryptedData);
    console.log(`[server] Saved to: ${outputPath}`);

    res.json({
      success: true,
      filename: safeFilename,
      decryptedBytes: decryptedData.length,
    });
  } catch (err) {
    console.error("[server] Decryption failed:", err);
    res.status(500).json({
      error: "Decryption failed.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] Running at http://localhost:${PORT}`);
});
