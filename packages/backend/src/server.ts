import express, { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------
console.log("[server] Generating RSA-2048 key pair...");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
console.log("[server] RSA-2048 key pair generated.");
console.log("[server] Public key (SPKI/PEM):\n" + publicKey);

// ---------------------------------------------------------------------------
// Uploads directory
// ---------------------------------------------------------------------------
const uploadsDir = path.join(__dirname, "..", "..", "..", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`[server] Created uploads directory: ${uploadsDir}`);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const frontendDir = path.join(__dirname, "..", "..", "frontend", "public");
app.use(express.static(frontendDir));
app.use(express.json({ limit: "100mb" }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Serve the RSA public key as PEM so the browser can import it. */
app.get("/api/public-key", (_req: Request, res: Response) => {
  console.log("[server] Public key requested by client.");
  res.json({ publicKey });
});

interface UploadBody {
  /** RSA-OAEP encrypted AES-256 session key, base64-encoded. */
  encryptedAesKey: string;
  /** AES-GCM encrypted file data (ciphertext + 16-byte auth tag), base64-encoded. */
  encryptedFile: string;
  /** AES-GCM 12-byte IV, base64-encoded. */
  iv: string;
  /** Original filename to use when saving. */
  filename: string;
}

/**
 * Receive an encrypted file upload.
 *
 * Expected JSON body:
 *   encryptedAesKey  – RSA-OAEP(SHA-256) encrypted 32-byte AES key (base64)
 *   encryptedFile    – AES-256-GCM ciphertext with auth tag appended (base64)
 *   iv               – 12-byte GCM IV (base64)
 *   filename         – original filename
 */
app.post("/api/upload", (req: Request, res: Response) => {
  try {
    const { encryptedAesKey, encryptedFile, iv, filename } =
      req.body as UploadBody;

    if (!encryptedAesKey || !encryptedFile || !iv || !filename) {
      res.status(400).json({ error: "Missing required fields." });
      return;
    }

    console.log(`\n[server] ─── Incoming encrypted upload: "${filename}" ───`);

    // 1. Decode base64 inputs
    const encryptedAesKeyBuf = Buffer.from(encryptedAesKey, "base64");
    const encryptedFileBuf = Buffer.from(encryptedFile, "base64");
    const ivBuf = Buffer.from(iv, "base64");

    console.log(
      `[server] Received encrypted AES key: ${encryptedAesKeyBuf.length} bytes (RSA-2048 ciphertext)`
    );
    console.log(
      `[server] Received encrypted file:    ${encryptedFileBuf.length} bytes (ciphertext + 16-byte GCM auth tag)`
    );
    console.log(`[server] Received IV:                 ${ivBuf.length} bytes`);

    // 2. Decrypt the AES session key with the RSA private key
    console.log(
      "[server] Decrypting AES session key with RSA private key (RSA-OAEP/SHA-256)..."
    );
    const aesKeyBuf = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      encryptedAesKeyBuf
    );
    console.log(
      `[server] AES session key decrypted: ${aesKeyBuf.length * 8}-bit key recovered.`
    );

    // 3. Split ciphertext and GCM auth tag
    // WebCrypto appends the 16-byte auth tag at the END of the ciphertext.
    const GCM_TAG_LENGTH = 16;
    const ciphertext = encryptedFileBuf.subarray(
      0,
      encryptedFileBuf.length - GCM_TAG_LENGTH
    );
    const authTag = encryptedFileBuf.subarray(
      encryptedFileBuf.length - GCM_TAG_LENGTH
    );
    console.log(
      `[server] Splitting ciphertext (${ciphertext.length} bytes) and GCM auth tag (${authTag.length} bytes)...`
    );

    // 4. Decrypt the file with AES-256-GCM
    console.log("[server] Decrypting file data with AES-256-GCM...");
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKeyBuf, ivBuf);
    decipher.setAuthTag(authTag);
    const decryptedChunks: Buffer[] = [
      decipher.update(ciphertext),
      decipher.final(),
    ];
    const decryptedData = Buffer.concat(decryptedChunks);
    console.log(
      `[server] File decrypted successfully: ${decryptedData.length} bytes of plaintext.`
    );

    // 5. Save decrypted file
    const safeFilename = path.basename(filename);
    const outputPath = path.join(uploadsDir, safeFilename);
    fs.writeFileSync(outputPath, decryptedData);
    console.log(`[server] Decrypted file saved to: ${outputPath}`);
    console.log(`[server] ─── Upload complete ───\n`);

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
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
