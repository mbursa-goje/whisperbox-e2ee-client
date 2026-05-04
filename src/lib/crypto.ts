import {
  base64ToBytes,
  bytesToBase64,
  bytesToText,
  textToBytes,
  toArrayBuffer,
} from "./encoding";
import type { MessagePayload } from "./types";

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const RSA_IMPORT_PARAMS: RsaHashedImportParams = {
  name: "RSA-OAEP",
  hash: "SHA-256",
};

const PBKDF2_ITERATIONS = 250_000;
const AES_KW_BLOCK_BYTES = 8;

export type RegistrationKeyBundle = {
  publicKey: string;
  wrappedPrivateKey: string;
  pbkdf2Salt: string;
  privateKey: CryptoKey;
};

export async function createRegistrationKeyBundle(
  password: string,
): Promise<RegistrationKeyBundle> {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "encrypt",
    "decrypt",
  ]);
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const wrappingKey = await deriveWrappingKey(password, salt);
  const publicKey = await exportPublicKey(pair.publicKey);
  const wrappedPrivateKey = await wrapPrivateKey(pair.privateKey, wrappingKey);

  return {
    publicKey,
    wrappedPrivateKey: bytesToBase64(wrappedPrivateKey),
    pbkdf2Salt: bytesToBase64(salt),
    privateKey: pair.privateKey,
  };
}

export async function unlockPrivateKey(
  password: string,
  wrappedPrivateKey: string,
  pbkdf2Salt: string,
): Promise<CryptoKey> {
  const salt = base64ToBytes(pbkdf2Salt);
  const wrappingKey = await deriveWrappingKey(password, salt);

  const paddedPrivateKeyCarrier = await crypto.subtle.unwrapKey(
    "raw",
    toArrayBuffer(base64ToBytes(wrappedPrivateKey)),
    wrappingKey,
    "AES-KW",
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const paddedPkcs8 = await crypto.subtle.exportKey("raw", paddedPrivateKeyCarrier);
  const pkcs8 = removeAesKwPadding(new Uint8Array(paddedPkcs8));

  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    RSA_IMPORT_PARAMS,
    false,
    ["decrypt"],
  );
}

export async function encryptMessageForUsers(
  plaintext: string,
  recipientPublicKeyBase64: string,
  senderPublicKeyBase64: string,
): Promise<MessagePayload> {
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    toArrayBuffer(textToBytes(plaintext)),
  );
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
  const senderPublicKey = await importPublicKey(senderPublicKeyBase64);
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPublicKey,
    rawAesKey,
  );
  const encryptedKeyForSelf = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    senderPublicKey,
    rawAesKey,
  );

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    encryptedKey: bytesToBase64(encryptedKey),
    encryptedKeyForSelf: bytesToBase64(encryptedKeyForSelf),
  };
}

export async function decryptMessagePayload(
  payload: MessagePayload,
  privateKey: CryptoKey,
  keySlot: "recipient" | "sender",
): Promise<string> {
  const wrappedAesKey =
    keySlot === "recipient" ? payload.encryptedKey : payload.encryptedKeyForSelf;
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    toArrayBuffer(base64ToBytes(wrappedAesKey)),
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(payload.iv)) },
    aesKey,
    toArrayBuffer(base64ToBytes(payload.ciphertext)),
  );

  return bytesToText(plaintext);
}

async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return bytesToBase64(spki);
}

async function wrapPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<ArrayBuffer> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const paddedPkcs8 = addAesKwPadding(new Uint8Array(pkcs8));
  const paddedPrivateKeyCarrier = await crypto.subtle.importKey(
    "raw",
    paddedPkcs8,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );

  return crypto.subtle.wrapKey(
    "raw",
    paddedPrivateKeyCarrier,
    wrappingKey,
    "AES-KW",
  );
}

async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    toArrayBuffer(base64ToBytes(publicKeyBase64)),
    RSA_IMPORT_PARAMS,
    false,
    ["encrypt"],
  );
}

async function deriveWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textToBytes(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

function addAesKwPadding(bytes: Uint8Array): ArrayBuffer {
  const paddingLength = AES_KW_BLOCK_BYTES - (bytes.byteLength % AES_KW_BLOCK_BYTES || AES_KW_BLOCK_BYTES);
  const padded = new Uint8Array(bytes.byteLength + paddingLength + AES_KW_BLOCK_BYTES);
  const view = new DataView(padded.buffer);

  view.setUint32(0, bytes.byteLength);
  padded.set(bytes, AES_KW_BLOCK_BYTES);

  return padded.buffer;
}

function removeAesKwPadding(bytes: Uint8Array): ArrayBuffer {
  const view = new DataView(toArrayBuffer(bytes.slice(0, AES_KW_BLOCK_BYTES)));
  const originalLength = view.getUint32(0);
  const unpadded = bytes.slice(AES_KW_BLOCK_BYTES, AES_KW_BLOCK_BYTES + originalLength);

  return toArrayBuffer(unpadded);
}
