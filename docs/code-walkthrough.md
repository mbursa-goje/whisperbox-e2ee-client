# Extremely Detailed Code Walkthrough

This document explains the WhisperBox E2EE client at a deliberately slow pace.
It is written for an evaluator, interviewer, or future maintainer who wants to
understand not only what each file does, but why each piece exists and how it
supports the end-to-end encryption requirement.

The shortest summary is this:

```text
React UI collects plaintext
  -> Web Crypto encrypts plaintext locally
  -> API/WebSocket transports ciphertext only
  -> backend stores encrypted blobs only
  -> recipient browser decrypts locally
```

The rest of this document expands that sentence into the actual code.

## Core Security Mental Model

The app has four kinds of data, and keeping them separate is the whole point of
the project.

1. Plaintext data:
   This is the human-readable message text typed into the composer or recovered
   after successful decryption. It should exist only inside the browser runtime.
   It should not be stored in IndexedDB, localStorage, or sent to the server.

2. Private key material:
   The raw RSA private key should never leave the client. During registration it
   exists briefly as a Web Crypto `CryptoKey`. Before storage, it is wrapped with
   a password-derived AES-KW key. During login, the wrapped private key is
   unwrapped into memory as a non-extractable `CryptoKey`.

3. Wrapped/encrypted cryptographic blobs:
   These are safe to send to the server because they are not directly usable as
   plaintext. Examples are `wrapped_private_key`, `ciphertext`, `encryptedKey`,
   and `encryptedKeyForSelf`.

4. Metadata:
   User IDs, usernames, display names, timestamps, and conversation membership
   are visible to the backend. This project protects content confidentiality,
   not metadata privacy.

Every source file supports one of these boundaries:

- `crypto.ts` is the content confidentiality boundary.
- `api.ts` is the HTTP transport boundary.
- `websocket.ts` is the realtime transport boundary.
- `sessionStore.ts` is the browser persistence boundary.
- `App.tsx` is the orchestration and UI boundary.
- `encoding.ts` is the binary-to-JSON conversion boundary.

## Data Flow: Registration

Registration happens in this order:

1. User types username, display name, and password in `AuthShell`.
2. `handleRegister` reads those values from the form.
3. `registerUser` calls `createRegistrationKeyBundle` before any API call.
4. `createRegistrationKeyBundle` generates RSA-OAEP keys.
5. It generates a PBKDF2 salt.
6. It derives an AES-KW wrapping key from the password and salt.
7. It exports the public key as base64 SPKI.
8. It exports the private key as PKCS#8, pads it to AES-KW's 8-byte block
   requirement, imports that padded byte string as a temporary raw carrier key,
   and wraps that carrier with AES-KW.
9. `registerUser` sends public key, wrapped private key, and salt to the API.
10. The raw private key remains in browser memory only.

The security meaning: the backend can store and return the private key only in
wrapped form. The password is needed locally to unwrap it.

## Data Flow: Login

Login happens in this order:

1. User types username and password.
2. `loginUser` calls `/auth/login`.
3. The backend returns tokens and the stored key blobs.
4. `unlockPrivateKey` derives the AES-KW wrapping key from the entered password
   and stored PBKDF2 salt.
5. `crypto.subtle.unwrapKey` turns the wrapped private key into a non-extractable
   RSA-OAEP private `CryptoKey`.
6. The session is saved in IndexedDB.
7. The unwrapped private key is kept only in React state.

The security meaning: restoring an account does not require the backend to know
the raw private key. If the password is wrong, unwrapping fails and the user
cannot decrypt content.

## Data Flow: Sending A Message

Sending happens in this order:

1. User types a draft.
2. `sendMessage` trims the draft and stops if it is empty.
3. It fetches the recipient public key from `/users/{id}/public-key`.
4. `encryptMessageForUsers` generates a fresh AES-GCM key.
5. It generates a fresh 96-bit IV.
6. It encrypts the plaintext with AES-GCM.
7. It exports the raw AES key.
8. It imports the recipient public RSA key.
9. It imports the sender public RSA key.
10. It encrypts the AES key for the recipient.
11. It encrypts the AES key for the sender.
12. It returns a payload containing only base64 cryptographic blobs.
13. `sendMessage` sends that payload by WebSocket or HTTP fallback.

The security meaning: the server receives a message object, but the message
content is already ciphertext before the WebSocket or HTTP layer sees it.

## Data Flow: Receiving A Message

Receiving happens in this order:

1. History comes from `getMessages`, or realtime data comes from WebSocket.
2. `decryptForCurrentUser` checks whether the current user sent or received the
   message.
3. Sent messages use `encryptedKeyForSelf`.
4. Received messages use `encryptedKey`.
5. `decryptMessagePayload` decrypts that RSA-OAEP-wrapped AES key.
6. It imports the recovered AES key.
7. It decrypts the AES-GCM ciphertext with the IV.
8. It returns plaintext for rendering.
9. If any step fails, the UI renders `Unable to decrypt message`.

The security meaning: only a browser with the correct private RSA key can recover
the AES key and therefore the message.

## File: `src/main.tsx`

```tsx
import { StrictMode } from "react";
```

This imports React's development guard component. `StrictMode` does not render
visible UI. It asks React to run additional checks in development, such as
calling certain lifecycle paths more than once. That is useful here because the
app manages side effects such as IndexedDB reads and WebSocket connections.

```tsx
import { createRoot } from "react-dom/client";
```

This imports the browser renderer. React components are abstract until mounted
into the DOM; `createRoot` is the function that connects React's virtual tree to
the actual `div#root` from `index.html`.

```tsx
import App from "./App";
```

This imports the root application component. All UI state, auth orchestration,
crypto calls, API calls, and WebSocket setup are reachable from this component.

```tsx
import "./index.css";
```

This side-effect import loads Tailwind CSS. The file does not export values.
Instead, Vite sees the CSS import, sends it through Tailwind's Vite plugin, and
injects the generated CSS into the page during development or bundles it during
production. The `src/vite-env.d.ts` file exists so TypeScript understands this
kind of import.

```tsx
createRoot(document.getElementById("root")!).render(
```

This finds the DOM node where the app should mount. The non-null assertion `!`
tells TypeScript that `#root` exists. That is safe because `index.html` contains
`<div id="root"></div>`.

```tsx
  <StrictMode>
```

This opens the development-check wrapper.

```tsx
    <App />
```

This renders the actual product.

```tsx
  </StrictMode>,
);
```

These lines close the wrapper and the render call.

## File: `src/index.css`

```css
@import "tailwindcss";
```

This is intentionally the whole CSS file. Tailwind v4 can be loaded directly
through this import when `@tailwindcss/vite` is registered in `vite.config.ts`.
There are no custom selectors such as `.button`, `.sidebar`, or `.bubble`.
That matters because the user explicitly requested Tailwind with nothing
overriding it. All styling choices live in JSX `className` strings.

## File: `src/vite-env.d.ts`

```ts
/// <reference types="vite/client" />
```

This declaration file tells TypeScript about Vite-specific browser features and
asset imports. Without it, VS Code can complain that `import "./index.css"` has
no type declarations. The production build may still work, but the editor would
show a false error. This line fixes the TypeScript language service.

## File: `src/lib/encoding.ts`

This file exists because cryptographic APIs produce binary data, while JSON APIs
send strings. The API guide expects base64 fields. The app therefore needs a
small, predictable conversion layer.

```ts
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
```

This declares a function that accepts two common binary shapes. Web Crypto often
returns `ArrayBuffer`; random byte generation often uses `Uint8Array`.

```ts
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
```

This normalizes the input. If the caller already passed a byte view, reuse it.
If the caller passed a raw buffer, create a view over it. The rest of the
function can now treat both cases the same way.

```ts
  let binary = "";
```

Base64 conversion with `btoa` expects a binary string, not a typed array. This
line creates that intermediate string.

```ts
  view.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
```

Each byte is converted into a single character whose char code matches the byte
value. This is not human-readable text; it is just a temporary representation
that `btoa` can encode.

```ts
  return btoa(binary);
}
```

This encodes the binary string as base64 and returns it. Base64 is safe to put
inside JSON request bodies.

```ts
export function base64ToBytes(value: string): Uint8Array {
```

This starts the inverse conversion. It accepts a base64 string from the API and
returns bytes for Web Crypto.

```ts
  const binary = atob(value);
```

`atob` decodes base64 into the same binary-string shape that `btoa` encoded.

```ts
  const bytes = new Uint8Array(binary.length);
```

This allocates exactly one byte for every character in the decoded binary
string.

```ts
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
```

This copies each character code back into the byte array.

```ts
  return bytes;
}
```

This returns bytes suitable for `crypto.subtle.importKey`, `decrypt`, and other
binary operations.

```ts
export function textToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
```

This converts user-visible text into UTF-8 bytes. AES-GCM encrypts bytes, not
JavaScript strings, so the conversion is explicit.

```ts
export function bytesToText(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}
```

This converts decrypted bytes back into a JavaScript string for message bubble
rendering.

```ts
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
```

This helper exists because newer TypeScript DOM typings can distinguish
`ArrayBuffer` from `SharedArrayBuffer` more strictly than older examples do.
Web Crypto wants `BufferSource`, and this helper guarantees the right shape.

```ts
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
```

This slices the exact byte range represented by the view. That detail matters:
a `Uint8Array` can point at only part of a larger buffer. Slicing avoids sending
extra bytes into cryptographic operations.

## File: `src/lib/types.ts`

This file defines the shared shapes used across the app. The main advantage is
that crypto, API, WebSocket, and UI code agree on exact field names.

### `UserProfile`

```ts
export type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  public_key: string;
  wrapped_private_key: string;
  pbkdf2_salt: string;
  created_at: string;
};
```

This mirrors the API's full authenticated user shape. The snake_case names are
intentional because the backend returns snake_case. `public_key` is safe to
share. `wrapped_private_key` is safe to store only because it is encrypted with
the password-derived wrapping key. `pbkdf2_salt` is not secret; it is needed to
derive the same wrapping key during login. `created_at` is metadata.

### `PublicUser`

```ts
export type PublicUser = {
  id: string;
  username: string;
  display_name: string;
};
```

This is the smaller shape returned by search. It intentionally does not include
private key material.

### `AuthResponse`

```ts
export type AuthResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  user: UserProfile;
};
```

This models register/login responses. `access_token` authenticates short-lived
API calls and WebSocket connections. `refresh_token` gets new access tokens.
`expires_in` is used to schedule proactive refresh. `user` carries the key blobs
needed to restore crypto state.

### `MessagePayload`

```ts
export type MessagePayload = {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  encryptedKeyForSelf: string;
};
```

This is the central encrypted payload. `ciphertext` is AES-GCM output. `iv` is
the AES-GCM nonce. `encryptedKey` is the AES key encrypted for the recipient.
`encryptedKeyForSelf` is the same AES key encrypted for the sender.

The server can store these strings but cannot derive plaintext from them without
the matching private RSA key.

### `MessageResponse`

```ts
export type MessageResponse = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  payload: MessagePayload;
  delivered?: boolean;
  created_at: string;
};
```

This is the server's message record. It includes metadata and encrypted payload.
`delivered` is optional because WebSocket frames and history items may not have
identical shapes.

### `Conversation`

```ts
export type Conversation = {
  user_id: string;
  display_name: string;
  username: string;
  last_message_at: string;
};
```

This supports the sidebar. It contains enough metadata to list chat partners,
but no message plaintext.

### `SessionRecord`

```ts
export type SessionRecord = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  user: UserProfile;
};
```

This is the app's normalized session shape. It converts API snake_case token
names into frontend camelCase. It is what gets saved to IndexedDB.

### `DecryptedMessage`

```ts
export type DecryptedMessage = MessageResponse & {
  text: string;
  decryptable: boolean;
  optimistic?: boolean;
  failed?: boolean;
};
```

This extends the server message with UI-only state. `text` is either decrypted
plaintext or a fallback failure label. `decryptable` tells the bubble which
style to use. `optimistic` marks a message shown before confirmation. `failed`
marks send failure.

## File: `src/lib/crypto.ts`

This is the most important file. It is where the E2EE promise becomes real. If
plaintext ever reached the API before passing through this file, the app would
fail its main security goal.

### Imports

```ts
import {
  base64ToBytes,
  bytesToBase64,
  bytesToText,
  textToBytes,
  toArrayBuffer,
} from "./encoding";
```

The crypto layer imports all binary conversion helpers. This keeps base64 and
UTF-8 logic out of the encryption functions themselves. That separation matters:
crypto functions should read like cryptographic steps, not string plumbing.

```ts
import type { MessagePayload } from "./types";
```

This imports the encrypted payload shape only for TypeScript. It does not create
runtime JavaScript.

### RSA Constants

```ts
const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};
```

`name: "RSA-OAEP"` selects RSA encryption padding suitable for encrypting small
secrets like AES keys. `modulusLength: 2048` follows the API guide. The public
exponent byte array `[1, 0, 1]` is 65537, the standard RSA exponent. SHA-256 is
the hash used inside OAEP.

```ts
const RSA_IMPORT_PARAMS: RsaHashedImportParams = {
  name: "RSA-OAEP",
  hash: "SHA-256",
};
```

Imported keys must use the same algorithm family and hash as generated keys.
This constant prevents mismatched RSA import settings.

```ts
const PBKDF2_ITERATIONS = 250_000;
```

PBKDF2 makes password-derived key guessing more expensive. The salt prevents
precomputed rainbow-table reuse. The iteration count is a security/usability
trade-off: higher is slower and stronger; lower is faster and weaker.

### Registration Bundle Type

```ts
export type RegistrationKeyBundle = {
  publicKey: string;
  wrappedPrivateKey: string;
  pbkdf2Salt: string;
  privateKey: CryptoKey;
};
```

This type describes the four things registration needs. Three are serialized
for the backend. One, `privateKey`, is kept in memory so the user can enter the
app immediately after registering without typing the password again.

### `createRegistrationKeyBundle`

```ts
export async function createRegistrationKeyBundle(
  password: string,
): Promise<RegistrationKeyBundle> {
```

This function is called before `/auth/register`. It accepts the password because
the password is the source material for the wrapping key. It returns a promise
because every Web Crypto operation is asynchronous.

```ts
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "encrypt",
    "decrypt",
  ]);
```

This creates the user's RSA keypair in the browser. The second argument is
`true`, meaning the key is extractable. That is required during registration
because the public key must be exported and the private key must be wrapped.
The usages allow the public key to encrypt and the private key to decrypt.

```ts
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
```

This creates 16 cryptographically secure random bytes, which is 128 bits. The
salt does not need to be secret, but it must be random so the same password does
not always derive the same wrapping key across users.

```ts
  const wrappingKey = await deriveWrappingKey(password, salt);
```

This derives an AES-KW key from the password and salt. That wrapping key is not
sent to the server. It exists only long enough to wrap the private key.

```ts
  const publicKey = await exportPublicKey(pair.publicKey);
```

The public key is exported as base64 SPKI. Public keys are meant to be shared,
so this is safe to send to the backend.

```ts
  const wrappedPrivateKey = await crypto.subtle.wrapKey(
    "pkcs8",
    pair.privateKey,
    wrappingKey,
    "AES-KW",
  );
```

This is the private-key protection step. The helper exports the RSA private key
as PKCS#8 bytes, pads those bytes to AES-KW's 8-byte block requirement, imports
the padded bytes as a temporary raw HMAC carrier key, and wraps that carrier
with the password-derived AES-KW key. The result is encrypted key material
suitable for storage.

```ts
  return {
    publicKey,
    wrappedPrivateKey: bytesToBase64(wrappedPrivateKey),
    pbkdf2Salt: bytesToBase64(salt),
    privateKey: pair.privateKey,
  };
}
```

This returns backend-ready base64 strings plus the in-memory private key.
`wrappedPrivateKey` and `pbkdf2Salt` are converted to base64 because JSON cannot
carry raw bytes directly.

### `unlockPrivateKey`

```ts
export async function unlockPrivateKey(
  password: string,
  wrappedPrivateKey: string,
  pbkdf2Salt: string,
): Promise<CryptoKey> {
```

This function restores the private key during login. It needs the password the
user just typed, plus the wrapped private key and salt returned by the server.

```ts
  const salt = base64ToBytes(pbkdf2Salt);
```

The salt returns from the server as base64, so it must become bytes before PBKDF2
can use it.

```ts
  const wrappingKey = await deriveWrappingKey(password, salt);
```

This repeats the registration derivation. Same password plus same salt should
produce the same AES-KW key.

```ts
  return crypto.subtle.unwrapKey(
    "pkcs8",
    toArrayBuffer(base64ToBytes(wrappedPrivateKey)),
    wrappingKey,
    "AES-KW",
    RSA_IMPORT_PARAMS,
    false,
    ["decrypt"],
  );
}
```

This unwraps the padded private-key carrier. AES-KW requires wrapped input to be
made of 8-byte blocks, and browser Web Crypto exposes AES-KW primarily through
`wrapKey`/`unwrapKey`, not direct arbitrary-data encryption. The implementation
therefore unwraps a temporary raw carrier key, exports its raw bytes, removes
the padding header, and then imports the original PKCS#8 bytes as an RSA-OAEP
private key. The final private key is non-extractable and decrypt-only.

### `encryptMessageForUsers`

```ts
export async function encryptMessageForUsers(
  plaintext: string,
  recipientPublicKeyBase64: string,
  senderPublicKeyBase64: string,
): Promise<MessagePayload> {
```

This function encrypts one message. It receives plaintext and two public keys:
recipient public key for the other user, sender public key for the current user.

```ts
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
```

This creates a fresh symmetric key for exactly this message. AES-GCM is used for
content encryption because it is fast and authenticated. `length: 256` gives a
256-bit key. The key is extractable because it must be exported so RSA can wrap
it for each participant.

```ts
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
```

This creates a 96-bit IV. AES-GCM requires a unique IV per key. Because each
message gets a fresh AES key, this random IV setup is appropriate for the demo.

```ts
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    toArrayBuffer(textToBytes(plaintext)),
  );
```

This is where plaintext becomes ciphertext. The plaintext string is UTF-8
encoded, normalized to `ArrayBuffer`, and encrypted with AES-GCM. After this
point, the API should only receive `ciphertext`, not `plaintext`.

```ts
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
```

This extracts the AES key bytes. That sounds dangerous, but it is done only
inside this function so the key can be encrypted with RSA for each participant.
The raw AES key is never sent to the backend.

```ts
  const recipientPublicKey = await importPublicKey(recipientPublicKeyBase64);
  const senderPublicKey = await importPublicKey(senderPublicKeyBase64);
```

These lines convert base64 public keys into Web Crypto `CryptoKey` objects.
Public keys can encrypt but cannot decrypt.

```ts
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPublicKey,
    rawAesKey,
  );
```

This seals the AES key for the recipient. Only the recipient's private key can
recover it.

```ts
  const encryptedKeyForSelf = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    senderPublicKey,
    rawAesKey,
  );
```

This seals the same AES key for the sender. Without this field, the sender could
send encrypted messages but could not decrypt their own sent-message history.

```ts
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    encryptedKey: bytesToBase64(encryptedKey),
    encryptedKeyForSelf: bytesToBase64(encryptedKeyForSelf),
  };
}
```

This returns the exact payload the API expects. All four fields are strings. The
server can store them, but it cannot decrypt them.

### `decryptMessagePayload`

```ts
export async function decryptMessagePayload(
  payload: MessagePayload,
  privateKey: CryptoKey,
  keySlot: "recipient" | "sender",
): Promise<string> {
```

This decrypts one encrypted payload. The caller provides the current user's
private key and tells the function which encrypted AES-key slot applies.

```ts
  const wrappedAesKey =
    keySlot === "recipient" ? payload.encryptedKey : payload.encryptedKeyForSelf;
```

This selects the right RSA-encrypted AES key. Recipients use the recipient slot.
Senders use the self slot.

```ts
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    toArrayBuffer(base64ToBytes(wrappedAesKey)),
  );
```

This uses the private RSA key to recover the raw AES-GCM key. If the private key
does not match, this throws.

```ts
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    "AES-GCM",
    false,
    ["decrypt"],
  );
```

This imports the recovered AES key for decrypt-only use. It is non-extractable
at this stage because it no longer needs to leave Web Crypto.

```ts
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(payload.iv)) },
    aesKey,
    toArrayBuffer(base64ToBytes(payload.ciphertext)),
  );
```

This decrypts and authenticates the ciphertext. AES-GCM verifies integrity. If
the ciphertext, IV, or key is wrong, the operation fails rather than returning
garbage plaintext.

```ts
  return bytesToText(plaintext);
}
```

This turns the decrypted bytes back into text for rendering.

### Private Crypto Helpers

```ts
async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return bytesToBase64(spki);
}
```

SPKI is the standard public-key export format. The result is base64-encoded for
the API.

```ts
async function importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    toArrayBuffer(base64ToBytes(publicKeyBase64)),
    RSA_IMPORT_PARAMS,
    false,
    ["encrypt"],
  );
}
```

This imports another user's public key. It is not extractable and can only
encrypt.

```ts
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
```

This helper handles the AES-KW edge case that caused the registration error.
AES-KW cannot wrap arbitrary byte lengths; its input must be a multiple of 8
bytes. RSA PKCS#8 exports are not guaranteed to have that length. The helper
therefore pads the PKCS#8 bytes, imports them as an extractable raw HMAC carrier
key, and asks AES-KW to wrap that carrier's raw key bytes. The HMAC key is not
used for authentication; it is only a standards-compatible carrier for padded
bytes.

```ts
async function deriveWrappingKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
```

This derives the AES-KW key used for private-key wrapping.

```ts
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textToBytes(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
```

This imports the password as PBKDF2 source material. It is not the final key.
It is only allowed to derive a key.

```ts
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
```

This applies PBKDF2 and returns an AES-KW key. The key is not extractable. It is
only allowed to wrap and unwrap keys. That limits accidental misuse.

```ts
function addAesKwPadding(bytes: Uint8Array): ArrayBuffer {
  const paddingLength = AES_KW_BLOCK_BYTES - (bytes.byteLength % AES_KW_BLOCK_BYTES || AES_KW_BLOCK_BYTES);
  const padded = new Uint8Array(bytes.byteLength + paddingLength + AES_KW_BLOCK_BYTES);
  const view = new DataView(padded.buffer);

  view.setUint32(0, bytes.byteLength);
  padded.set(bytes, AES_KW_BLOCK_BYTES);

  return padded.buffer;
}
```

This creates a reversible padded byte buffer. The first 8 bytes are a header.
The first 4 bytes of that header store the original PKCS#8 length. The remaining
header bytes stay zero. The original private-key bytes start after the 8-byte
header. Extra zero padding is added only as needed so the total length is valid
for AES-KW.

```ts
function removeAesKwPadding(bytes: Uint8Array): ArrayBuffer {
  const view = new DataView(toArrayBuffer(bytes.slice(0, AES_KW_BLOCK_BYTES)));
  const originalLength = view.getUint32(0);
  const unpadded = bytes.slice(AES_KW_BLOCK_BYTES, AES_KW_BLOCK_BYTES + originalLength);

  return toArrayBuffer(unpadded);
}
```

This reverses the padding. It reads the original length from the header, slices
exactly that many bytes after the header, and returns the original PKCS#8
private-key bytes for `crypto.subtle.importKey`.

## File: `src/lib/sessionStore.ts`

This file owns browser persistence. It intentionally uses IndexedDB instead of
localStorage. IndexedDB is still client-side storage, so it is not magically
secure, but it is the better fit for structured browser data and satisfies the
assignment guidance.

```ts
const DB_NAME = "whisperbox-client";
const STORE_NAME = "session";
const SESSION_KEY = "current";
```

These constants name the database, object store, and single record. The app is a
single-user browser session, so a fixed key is enough.

```ts
let openRequest: Promise<IDBDatabase> | null = null;
```

This caches the database connection promise. Without this, every session read or
write would start a new `indexedDB.open` flow.

```ts
export async function saveSession(record: SessionRecord): Promise<void> {
  const db = await openDatabase();
  await requestToPromise(
    db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(record, SESSION_KEY),
  );
}
```

This opens the database, starts a read-write transaction, selects the `session`
object store, and writes the record at key `current`. The saved record contains
tokens and wrapped key material, not plaintext messages or raw private keys.

```ts
export async function loadSession(): Promise<SessionRecord | null> {
  const db = await openDatabase();
  const record = await requestToPromise<SessionRecord | undefined>(
    db.transaction(STORE_NAME).objectStore(STORE_NAME).get(SESSION_KEY),
  );

  return record ?? null;
}
```

This reads the session. If nothing is stored, IndexedDB returns `undefined`, and
the function normalizes that to `null`, which is easier for React state.

```ts
export async function clearSession(): Promise<void> {
  const db = await openDatabase();
  await requestToPromise(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(SESSION_KEY),
  );
}
```

This deletes the saved session during logout or invalid-token handling.

```ts
function openDatabase(): Promise<IDBDatabase> {
  openRequest ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
```

This lazily creates the open promise. Version `1` is the first schema version.

```ts
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
```

When the database is first created, this creates the `session` object store.

```ts
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return openRequest;
}
```

These lines resolve or reject the promise based on IndexedDB events.

```ts
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
```

IndexedDB uses event callbacks. This wrapper turns those callbacks into promises
so the rest of the app can use `await`.

## File: `src/lib/api.ts`

This file is deliberately not responsible for encryption, except during auth
where it calls the crypto setup functions. Its job is HTTP transport and session
normalization.

```ts
import { createRegistrationKeyBundle, unlockPrivateKey } from "./crypto";
import { clearSession, saveSession } from "./sessionStore";
```

Auth needs crypto because registration creates keys and login unlocks keys.
Auth also needs session storage because successful auth should persist tokens.

```ts
import type {
  AuthResponse,
  Conversation,
  MessagePayload,
  MessageResponse,
  PublicUser,
  SessionRecord,
  UserProfile,
} from "./types";
```

These imports keep every request and response typed. This reduces accidental
field-name drift between frontend and backend.

```ts
export const API_BASE_URL = "https://whisperbox.koyeb.app";
```

All HTTP requests point to the hosted backend.

```ts
type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  accessToken?: string;
};
```

The native `RequestInit.body` type accepts many browser body shapes. This app
wants JSON bodies, so it replaces `body` with `unknown` and serializes it inside
the helper. `accessToken` is a convenience field for bearer auth.

### `registerUser`

```ts
export async function registerUser(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<{ session: SessionRecord; privateKey: CryptoKey }> {
```

This function receives clean frontend field names and returns both saved session
data and the runtime private key.

```ts
  const bundle = await createRegistrationKeyBundle(input.password);
```

This is the key security ordering. Keys are generated and the private key is
wrapped before the backend sees the registration request.

```ts
  const response = await request<AuthResponse>("/auth/register", {
    method: "POST",
    body: {
      username: input.username,
      display_name: input.displayName,
      password: input.password,
      public_key: bundle.publicKey,
      wrapped_private_key: bundle.wrappedPrivateKey,
      pbkdf2_salt: bundle.pbkdf2Salt,
    },
  });
```

This sends exactly what the API guide asks for. Notice that `privateKey` is not
included. Only `wrapped_private_key` is sent.

```ts
  const session = toSession(response);
  await saveSession(session);

  return { session, privateKey: bundle.privateKey };
}
```

The response is normalized, saved, and returned with the in-memory private key.

### `loginUser`

```ts
export async function loginUser(input: {
  username: string;
  password: string;
}): Promise<{ session: SessionRecord; privateKey: CryptoKey }> {
```

Login returns the same runtime shape as registration.

```ts
  const response = await request<AuthResponse>("/auth/login", {
    method: "POST",
    body: input,
  });
```

This authenticates with the backend. The password is sent to the backend because
the provided API uses password auth, but message plaintext and raw private keys
are not sent.

```ts
  const privateKey = await unlockPrivateKey(
    input.password,
    response.user.wrapped_private_key,
    response.user.pbkdf2_salt,
  );
```

This locally unlocks the wrapped private key. If this fails, the app cannot
enter a decrypt-capable chat session.

```ts
  const session = toSession(response);
  await saveSession(session);

  return { session, privateKey };
}
```

This persists the session and returns the unlocked private key in memory.

### Token Refresh And Logout

```ts
export async function refreshSession(
  session: SessionRecord,
): Promise<SessionRecord> {
```

This refreshes the short-lived access token.

```ts
  const response = await request<{
    access_token: string;
    token_type: "bearer";
    expires_in: number;
  }>("/auth/refresh", {
    method: "POST",
    body: { refresh_token: session.refreshToken },
  });
```

The refresh endpoint does not need an access token; it needs the refresh token
in the body.

```ts
  const refreshed = {
    ...session,
    accessToken: response.access_token,
    accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
  };
  await saveSession(refreshed);

  return refreshed;
}
```

The new access token replaces the old one and the updated session is persisted.

```ts
export async function logout(session: SessionRecord): Promise<void> {
  try {
    await request("/auth/logout", {
      method: "POST",
      accessToken: session.accessToken,
      body: { refresh_token: session.refreshToken },
    });
  } finally {
    await clearSession();
  }
}
```

The `finally` block is intentional. Even if the network fails, local session
state should be cleared so the browser no longer behaves as logged in.

### Read Endpoints

```ts
export async function getMe(accessToken: string): Promise<UserProfile> {
  return request<UserProfile>("/auth/me", { accessToken });
}
```

Fetches the current user profile.

```ts
export async function searchUsers(
  accessToken: string,
  query: string,
): Promise<PublicUser[]> {
  if (query.trim().length < 2) return [];
  return request<PublicUser[]>(
    `/users/search?q=${encodeURIComponent(query.trim())}`,
    { accessToken },
  );
}
```

Debounced UI search calls this. Very short queries return locally to reduce
unnecessary requests. `encodeURIComponent` protects the URL query string.

```ts
export async function getPublicKey(
  accessToken: string,
  userId: string,
): Promise<string> {
  const response = await request<{ public_key: string }>(
    `/users/${userId}/public-key`,
    { accessToken },
  );
  return response.public_key;
}
```

This is required before sending a message. The recipient public key is what lets
the sender encrypt the AES key for that recipient.

```ts
export async function getConversations(
  accessToken: string,
): Promise<Conversation[]> {
  return request<Conversation[]>("/conversations", { accessToken });
}
```

Fetches sidebar conversations.

```ts
export async function getMessages(
  accessToken: string,
  userId: string,
): Promise<MessageResponse[]> {
  return request<MessageResponse[]>(
    `/conversations/${userId}/messages?limit=50`,
    { accessToken },
  );
}
```

Fetches encrypted history. The API returns newest first; the UI later sorts for
display.

```ts
export async function sendMessageFallback(
  accessToken: string,
  to: string,
  payload: MessagePayload,
): Promise<MessageResponse> {
  return request<MessageResponse>("/messages", {
    method: "POST",
    accessToken,
    body: { to, payload },
  });
}
```

This sends already-encrypted payloads when WebSocket is unavailable. This helper
does not accept plaintext.

### Private Request Helper

```ts
async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
```

This generic helper returns the expected response type.

```ts
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
```

All requests expect JSON responses.

```ts
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
```

`Content-Type` is added only when sending JSON. This avoids misleading headers
on bodyless GET requests.

```ts
  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }
```

Authenticated endpoints receive the bearer token.

```ts
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
```

This builds the final request. Bodies are serialized as JSON exactly once.

```ts
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
```

Non-2xx responses become thrown errors, which the UI catches and displays.

```ts
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
```

Empty responses return `undefined`; other successes parse JSON.

```ts
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    return `Request failed with status ${response.status}`;
  }

  return `Request failed with status ${response.status}`;
}
```

The backend usually returns `{ detail: "..." }` on errors. This helper preserves
that message when possible.

```ts
function toSession(response: AuthResponse): SessionRecord {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
    user: response.user,
  };
}
```

This converts API token names into frontend state names and calculates an
absolute expiry timestamp.

## File: `src/lib/websocket.ts`

This file isolates realtime behavior from React. React should not need to know
close-code details or frame parsing rules.

```ts
import { API_BASE_URL, refreshSession } from "./api";
import type { MessageResponse, SessionRecord } from "./types";
```

The socket needs the base URL, refresh logic, and message/session types.

```ts
type WhisperSocketHandlers = {
  onMessage: (message: MessageResponse) => void;
  onPresence: (userId: string, online: boolean) => void;
  onError: (message: string) => void;
  onSession: (session: SessionRecord) => void;
  onAuthExpired: () => void;
  onStatus: (status: "connecting" | "online" | "offline") => void;
};
```

These callbacks let the class report events without importing React state
setters directly. That keeps it reusable and easier to reason about.

```ts
export class WhisperSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
```

The class stores the active browser WebSocket and the retry timer ID.

```ts
  constructor(
    private session: SessionRecord,
    private handlers: WhisperSocketHandlers,
  ) {}
```

The constructor stores the current session and callbacks using TypeScript
parameter properties.

```ts
  connect() {
    this.handlers.onStatus("connecting");
```

The UI is told immediately that realtime is not fully online yet.

```ts
    const wsBase = API_BASE_URL.replace("https://", "wss://").replace(
      "http://",
      "ws://",
    );
```

The API base URL is HTTP(S). WebSocket needs WS(S). This conversion keeps the
source of truth in one place.

```ts
    this.socket = new WebSocket(
      `${wsBase}/ws?token=${encodeURIComponent(this.session.accessToken)}`,
    );
```

Browsers cannot attach custom headers during WebSocket upgrades, so the API
requires the token in the query string. `encodeURIComponent` protects special
characters in the JWT.

```ts
    this.socket.onopen = () => this.handlers.onStatus("online");
    this.socket.onmessage = (event) => this.handleFrame(event.data);
    this.socket.onerror = () => this.handlers.onError("Realtime channel failed");
    this.socket.onclose = (event) => this.handleClose(event.code);
  }
```

These handlers translate browser events into application callbacks.

```ts
  updateSession(session: SessionRecord) {
    this.session = session;
  }
```

When refresh produces a new token, React can update the socket's stored session.

```ts
  send(to: string, payload: MessageResponse["payload"]): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ event: "message.send", to, payload }));
    return true;
  }
```

This sends an encrypted payload. Returning `false` allows the caller to use the
HTTP fallback. Again, plaintext is not accepted here.

```ts
  close() {
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.handlers.onStatus("offline");
  }
```

This stops reconnect attempts, closes normally with code `1000`, removes the
socket reference, and updates UI status.

```ts
  private handleFrame(raw: string) {
    try {
      const frame = JSON.parse(raw) as {
        event?: string;
        detail?: string;
        user_id?: string;
      } & MessageResponse;
```

Incoming WebSocket frames are strings. This parses JSON and gives TypeScript a
combined frame shape.

```ts
      if (frame.event === "message.receive") {
        this.handlers.onMessage(frame);
      } else if (frame.event === "user.online" && frame.user_id) {
        this.handlers.onPresence(frame.user_id, true);
      } else if (frame.event === "user.offline" && frame.user_id) {
        this.handlers.onPresence(frame.user_id, false);
      } else if (frame.event === "error") {
        this.handlers.onError(frame.detail ?? "Realtime error");
      }
```

Each backend event type is routed to the correct callback.

```ts
    } catch {
      this.handlers.onError("Received an unreadable realtime event");
    }
  }
```

Malformed JSON becomes a user-visible error instead of crashing the app.

```ts
  private async handleClose(code: number) {
    this.handlers.onStatus("offline");
```

Any close means the socket is no longer online.

```ts
    if (code === 1000) return;
```

Normal close requires no recovery.

```ts
    if (code === 4003) {
      this.handlers.onAuthExpired();
      return;
    }
```

The API says `4003` means invalid token. Retrying would not help, so the app
logs out.

```ts
    if (code === 4001) {
      try {
        const refreshed = await refreshSession(this.session);
        this.session = refreshed;
        this.handlers.onSession(refreshed);
        this.connect();
      } catch {
        this.handlers.onAuthExpired();
      }
      return;
    }
```

The API says `4001` means expired access token. The socket refreshes the token,
updates session state, and reconnects. If refresh fails, login is required.

```ts
    this.reconnectTimer = window.setTimeout(() => this.connect(), 2200);
  }
}
```

Other abnormal closes retry after a small delay.

## File: `src/App.tsx`

`App.tsx` is intentionally the coordinator. It does not implement low-level
crypto primitives, but it decides when to call them.

### Imports And Shared UI Classes

Lines 1-14 import lucide icons. These keep buttons and status states visually
familiar without custom SVG code.

Line 15 imports React primitives. `useState` stores UI/session state. `useEffect`
runs side effects. `useMemo` sorts messages efficiently. `useCallback` gives
stable functions to effects. `useRef` stores the live socket instance without
causing re-renders. `FormEvent` types form submit handlers.

Lines 16-26 import API operations. Notice that `App.tsx` does not call `fetch`
directly; HTTP details live in `api.ts`.

Line 27 imports crypto operations. Notice that `App.tsx` does not manually
build AES or RSA calls; crypto details live in `crypto.ts`.

Line 28 imports `loadSession`, the only IndexedDB call the boot effect needs.

Lines 29-35 import types used by React state and functions.

Line 36 imports `WhisperSocket`, the WebSocket abstraction.

Lines 38-39 define small local UI state unions. `View` keeps screen mode limited
to known values. `Toast` keeps notification tone limited to `info` or `error`.

Line 41 sets `emptyConversation` to `null`. This gives the initial selected
conversation state an explicit type.

Lines 42-47 define repeated Tailwind class strings. This avoids repeating long
utility lists for every icon button, avatar, and auth input.

### State Initialization

Line 49 starts `App`.

Line 50 stores whether the user is looking at login, register, or chat.

Line 51 stores whether the app is still checking IndexedDB on startup.

Line 52 stores the authenticated session. `null` means no usable token state.

Line 53 stores the unwrapped private key. This is deliberately React memory,
not IndexedDB.

Line 54 stores the sidebar conversation list.

Line 55 stores the selected conversation. `null` means no thread selected.

Line 56 stores decrypted messages or decryption failure placeholders.

Line 57 stores the user-search input.

Line 58 stores user-search results.

Line 59 stores the message composer draft. This is plaintext, so it stays in
browser memory only.

Line 60 stores toast state.

Line 61 stores thread loading state.

Line 62 stores auth-submit loading state.

Line 63 stores WebSocket connection status.

Line 64 stores presence data as a `Set` of online user IDs.

Line 65 stores the `WhisperSocket` instance without re-rendering on every socket
mutation.

### Derived Values

Line 67 calculates the chat header name. If no user is selected, it falls back
to the product name.

Lines 68-71 sort messages from oldest to newest for display. The API returns
newest first, so the UI reverses that mental order.

### Logout

Lines 73-82 define `handleLogout`. It closes realtime, revokes the refresh
token if a session exists, clears private key and message state, and returns to
login. Clearing `privateKey` is especially important because it removes the
runtime decrypt capability.

### Decryption

Lines 84-99 define `decryptForCurrentUser`. It first checks that both session
and private key exist. If not, the app cannot decrypt. It then chooses the key
slot based on sender ID. If the current user sent the message, it uses the self
slot. Otherwise it uses the recipient slot. Any exception becomes an
`Unable to decrypt message` bubble. This graceful failure is important because
one corrupted message should not break the entire thread.

### Realtime Receive

Lines 101-108 define `receiveRealtimeMessage`. It decrypts the incoming message,
deduplicates by message ID, appends the decrypted result, and refreshes
conversation ordering.

### History Loading

Lines 110-125 define `loadThread`. It sets the loading flag, fetches encrypted
history, decrypts every message in parallel with `Promise.all`, saves the
decrypted list, and always clears loading in `finally`.

### Boot Effect

Lines 127-140 run once on mount. They load any saved session from IndexedDB.
If one exists, the app does not enter chat immediately because the private key
is not stored unwrapped. Instead, it keeps the user on login and shows a toast
asking them to unlock messages with their password.

### WebSocket Effect

Lines 142-164 run only when both `session` and `privateKey` exist. That condition
is the secure runtime gate. The app should not open realtime messaging unless it
can decrypt incoming messages. The effect loads conversations, creates a
`WhisperSocket`, wires message/presence/error/session/auth/status callbacks,
connects the socket, and closes it during cleanup.

### Token Refresh Effect

Lines 166-179 schedule proactive access-token refresh. The timeout is calculated
for one minute before expiry, with a minimum of ten seconds. Refresh success
updates React state and the socket session. Refresh failure logs out.

### Selected Thread Effect

Lines 181-184 load the thread whenever the selected conversation, private key,
or session changes.

### Search Effect

Lines 186-197 debounce search. The 220ms delay keeps the UI responsive while
avoiding an API request for every keystroke.

### Registration Handler

Lines 199-220 read form values, set loading, show a key-generation toast, call
`registerUser`, store the returned session and private key, switch to chat, and
surface errors. This handler is where user input crosses from UI into the auth
and crypto setup flow.

### Login Handler

Lines 222-242 read credentials, show an unlock toast, call `loginUser`, store
session/private key, switch to chat, and surface errors. This is where wrapped
private key material becomes a runtime `CryptoKey`.

### Conversation Loading

Lines 244-250 fetch the conversation list and show any API error in a toast.

### Starting A Conversation

Lines 252-266 turn a search result into a selected conversation. It also
optimistically inserts that person into the sidebar and clears search state.

### Sending A Message

Lines 268-270 prevent default form submission and stop if session, selected
conversation, or draft text is missing.

Line 272 trims the plaintext.

Line 273 creates a temporary optimistic ID.

Line 274 clears the composer immediately so sending feels responsive.

Line 277 fetches the recipient public key. This must happen before encryption.

Lines 278-282 encrypt the plaintext for recipient and sender. After this call,
the transport payload is safe for the server to store.

Lines 283-293 create an optimistic decrypted message for local rendering. It
contains plaintext in UI memory, but the payload inside it is encrypted.

Line 294 appends the optimistic bubble.

Line 296 tries WebSocket delivery.

Lines 297-299 use the optimistic message as the stored result if WebSocket send
succeeds, or use HTTP fallback if the socket is unavailable.

Lines 301-307 replace the optimistic item with the confirmed delivered state.

Line 308 refreshes conversations.

Lines 309-316 mark the optimistic bubble as failed and show an error if any send
step fails.

### Render Branches

Lines 319-321 show `Splash` while IndexedDB boot is unresolved.

Lines 323-334 show auth UI unless the app has chat view, session, and private
key. This prevents a token-only session from entering chat without decrypt
capability.

Lines 336-420 render the sidebar. It includes current user identity, logout,
search, search results, conversations, active row styling, and online dots.

Lines 422-520 render the chat panel. It includes mobile back navigation, avatar,
encrypted header, socket status, slim message bubbles, empty secure state, and
composer.

The message bubble render is intentionally restrained. Successful messages show
only the message body. Earlier versions displayed an `encrypted` label under
every sent message, but that made the bubble visually noisy and increased its
height. The final UI keeps the encryption promise in the chat header and empty
state, while each bubble stays compact enough to feel like a normal messaging
app. Failed sends are the exception: they still render a small `failed` line
with an alert icon because the user needs to know that action did not complete.

Outgoing bubbles use a clean blue fill instead of a multi-color gradient. The
rest of the dashboard already carries the WhisperBox color system through
headers, icons, search, and empty states. Using a simpler message fill improves
legibility, removes the blurry color-sheet effect, and makes short messages like
`Hey` look intentional rather than over-designed.

Lines 522-535 render toasts. Toasts are positioned at the top-right instead of
the bottom-right so they do not cover the chat composer while the user is typing.
Error toasts are red and remain visible because they require attention. Info
toasts are neutral and are cleared when the user opens a conversation or starts
typing, because they should guide the next action without blocking it.

### Helper Components

Lines 538-547 define `Splash`, the small boot screen.

Lines 549-649 define `AuthShell`, the login/register UI. It chooses register
mode based on `props.mode`, conditionally shows display name, validates username
and password constraints in the browser, and calls the correct submit handler.

Lines 651-657 define `Avatar`. It uses the first display-name character and a
Tailwind gradient-border treatment.

Lines 659-672 define `StatusPill`. It maps socket status to color.

Lines 674-676 define `EmptyLine`.

Lines 678-681 define `readableError`, which converts unknown thrown values into
safe display text.

## Tailwind And UI Reasoning

Tailwind is the only styling system:

- `vite.config.ts` registers `tailwindcss()`.
- `src/index.css` imports Tailwind.
- `App.tsx` uses utility classes directly.
- There are no component CSS selectors overriding utility output.

The UI borrows the Instagram Direct structure:

- Auth card centered beside a phone-like preview on desktop.
- Left rail for profile, search, and conversations.
- Main panel for selected chat.
- Slim rounded bubbles that show message text only unless a send fails.
- Blue outgoing messages.
- Neutral incoming messages.
- Mobile switches between list and chat instead of squeezing both.

It remains WhisperBox-branded through copy, lock icons, encryption indicators,
and the security-focused empty state.

## Requirement Mapping

Authentication:
`registerUser`, `loginUser`, `refreshSession`, `logout`, and `SessionRecord`
implement token-based auth and session management.

Key management:
`createRegistrationKeyBundle`, `unlockPrivateKey`, `deriveWrappingKey`,
`sessionStore.ts`, and React `privateKey` state implement public key storage,
wrapped private key persistence, and in-memory-only raw private key handling.

Encrypted messaging:
`encryptMessageForUsers`, `decryptMessagePayload`, `sendMessage`,
`receiveRealtimeMessage`, `getMessages`, and `sendMessageFallback` implement
client encryption and decryption.

Backend plaintext protection:
The API and WebSocket layers receive encrypted payloads. Plaintext is converted
to ciphertext before `socketRef.current?.send` or `sendMessageFallback`.

UI and UX:
The app includes secure indicators, loading states, search empty states,
decryption failure bubbles, send failure states, compact message bubbles without
per-message encryption labels, responsive layout, and a familiar direct-message
interaction model.

Known limitations:
The implementation does not provide full forward secrecy because long-lived RSA
keys protect message keys. It does not hide metadata such as sender, recipient,
and timestamps. Refresh-token persistence is a practical frontend-demo trade-off.
