# Dense Code Walkthrough

This document walks through the app slowly, file by file. The mental model is
simple: the backend is a mailbox for ciphertext, while the browser is the only
place where plaintext and private keys exist.

## `src/main.tsx`

`StrictMode` enables React's development checks. `createRoot` attaches the React
tree to the `#root` element from `index.html`. `App` is the entire product
surface. `styles.css` is imported once here so the UI rules apply globally.

## `src/lib/encoding.ts`

The API speaks JSON, so binary cryptographic outputs must be represented as
strings. `bytesToBase64` accepts either an `ArrayBuffer` or `Uint8Array`, walks
each byte, builds a binary string, and passes it to `btoa`. `base64ToBytes` does
the inverse: `atob` returns a binary string, then each character code is copied
into a `Uint8Array`. `textToBytes` and `bytesToText` isolate UTF-8 conversion so
the crypto file never hand-rolls text encoding.

## `src/lib/crypto.ts`

`RSA_PARAMS` defines the registration keypair: RSA-OAEP, 2048-bit modulus,
standard `65537` public exponent, and SHA-256. `RSA_IMPORT_PARAMS` repeats the
algorithm and hash for imported public and private keys. Keeping both constants
near the top makes it obvious that encryption and decryption use the same
primitive.

`PBKDF2_ITERATIONS` is set to `250_000`. The purpose is to slow password
guessing before the wrapping key is derived. More iterations increase security
but also make low-powered devices wait longer during registration and login.

`createRegistrationKeyBundle(password)` is called before `/auth/register`.
First, `crypto.subtle.generateKey` creates an extractable RSA keypair because
the public key must be exported and the private key must be wrapped. The salt is
16 random bytes from `crypto.getRandomValues`. The wrapping key is derived from
the password and salt. The public key is exported as SPKI base64. The private
key is wrapped as PKCS#8 using AES-KW. The return object contains the server
blobs plus the in-memory private key for the new session.

`unlockPrivateKey(password, wrappedPrivateKey, pbkdf2Salt)` is the login mirror.
It decodes the salt, derives the same AES-KW key, then calls
`crypto.subtle.unwrapKey`. The unwrapped private key is imported as
non-extractable and can only be used for `decrypt`, which keeps runtime handling
tighter than the registration key.

`encryptMessageForUsers(plaintext, recipientPublicKeyBase64,
senderPublicKeyBase64)` implements hybrid encryption. A fresh AES-GCM key is
generated for one message. A 12-byte IV is generated because 96-bit IVs are the
standard shape for AES-GCM. The plaintext is UTF-8 encoded and encrypted. The
AES key is exported in raw form only long enough to encrypt it twice: once for
the recipient and once for the sender. The function returns the exact payload
shape the WhisperBox API expects.

`decryptMessagePayload(payload, privateKey, keySlot)` chooses the right wrapped
AES key. Received messages use `encryptedKey`; sent messages use
`encryptedKeyForSelf`. RSA-OAEP decrypts that value back to raw AES key bytes.
The raw bytes are imported as an AES-GCM key, then AES-GCM decrypts the
ciphertext with the stored IV. The result is decoded back into text.

Private helpers keep format details out of app code. `exportPublicKey` exports
SPKI and base64-encodes it. `importPublicKey` reverses that process and allows
only encryption. `deriveWrappingKey` imports the password as PBKDF2 material and
derives a 256-bit AES-KW key that can wrap and unwrap the private RSA key.

## `src/lib/sessionStore.ts`

This file owns IndexedDB. The app intentionally avoids `localStorage` because
the assignment calls out sensitive storage. `DB_NAME`, `STORE_NAME`, and
`SESSION_KEY` name a single database entry for the current login. The stored
record contains tokens and wrapped key material, not plaintext messages or raw
private keys.

`openRequest` caches the database-opening promise so repeated reads do not open
new connections. `saveSession` opens a read-write transaction and writes the
record under the fixed key. `loadSession` reads that key and returns `null` when
there is no saved session. `clearSession` deletes the key on logout or auth
failure. `requestToPromise` turns IndexedDB's event-based API into promises so
the rest of the code can use `async` and `await`.

## `src/lib/api.ts`

`API_BASE_URL` points at the hosted backend. Every exported function maps to one
backend concept and hides headers, JSON parsing, and error formatting.

`registerUser` first calls `createRegistrationKeyBundle`. That ordering matters:
key generation happens before the server sees the account request. The request
body uses the API's snake_case field names. After the backend responds, `toSession`
normalizes token names into frontend names and `saveSession` persists the
session. The function also returns the private key so the UI can start a secure
runtime session immediately.

`loginUser` sends username and password to `/auth/login`, then unwraps the
private key from the returned key blobs. Saving the session only happens after
the cryptographic unlock succeeds.

`refreshSession` sends the refresh token to `/auth/refresh`, replaces the access
token, calculates a new expiry timestamp, and saves the updated record.
`logout` asks the backend to revoke the refresh token, then clears IndexedDB in
a `finally` block so local cleanup happens even if the network call fails.

`searchUsers`, `getPublicKey`, `getConversations`, `getMessages`, and
`sendMessageFallback` are thin endpoint wrappers. `searchUsers` returns an empty
list for very short queries, which avoids noisy API calls while the user types.

The private `request` helper builds JSON headers, attaches `Authorization:
Bearer <token>` when an access token is present, serializes request bodies, and
throws readable `Error` objects for non-2xx responses. `errorMessage` prefers the
backend's `detail` string, then falls back to the HTTP status.

## `src/lib/websocket.ts`

`WhisperSocket` wraps browser WebSocket behavior so React does not need to know
about close codes or frame parsing. The constructor receives a session and a
set of callbacks. `connect` converts the HTTPS API base URL into WSS, appends
the access token as the `token` query parameter, and wires open, message, error,
and close handlers.

`send` serializes the `message.send` event expected by the backend. It returns
`false` when the socket is not open so the caller can use the HTTP fallback.

`handleFrame` parses server events. `message.receive` becomes an app message.
`user.online` and `user.offline` update presence. Backend `error` frames become
visible toasts.

`handleClose` is where token behavior lives. Code `4001` means the access token
expired, so the class refreshes the session and reconnects. Code `4003` means
the token is invalid, so the app clears auth state. Other abnormal closes retry
after a short delay.

## `src/App.tsx`

`App` is the product shell and state coordinator. State is split by concern:
auth view, session, private key, conversations, selected thread, decrypted
messages, user search, draft text, toast messages, loading flags, WebSocket
status, and presence.

The first `useEffect` tries to load a saved IndexedDB session. It does not unlock
the private key because the password is not stored. Instead, it returns the user
to login with a toast explaining that the session exists but messages need to be
unlocked.

The second `useEffect` starts once both `session` and `privateKey` exist. That is
the secure runtime boundary. Conversations load, a `WhisperSocket` is created,
incoming messages are decrypted, presence events update a `Set`, session refresh
events update React state, and auth expiration logs the user out.

The third `useEffect` schedules proactive token refresh before expiry. This
prevents the WebSocket from needing to close at exactly the 15-minute mark.

The selected-thread effect loads encrypted history and calls `decryptForCurrentUser`
for every item. The search effect debounces user search by 220ms.

`handleRegister` reads form fields, generates keys through `registerUser`, saves
the returned session, keeps the private key in memory, and enters the chat UI.
`handleLogin` follows the same shape but unlocks existing key material.

`handleLogout` closes the socket, revokes the refresh token when possible,
clears local state, and returns to login.

`decryptForCurrentUser` decides which key slot to use. If the current user sent
the message, it uses `encryptedKeyForSelf`; otherwise it uses `encryptedKey`.
Any cryptographic exception becomes a non-crashing message bubble.

`sendMessage` is the most important user action. It fetches the recipient public
key, encrypts the plaintext before transport, creates an optimistic local bubble,
tries WebSocket delivery, falls back to `POST /messages` when the socket is not
open, and updates the conversation list. The plaintext draft is never sent to
the backend.

The render tree has two major modes. Auth mode shows an Instagram-inspired
login/register layout with a phone preview and simple form card. Chat mode shows
a conversation rail, search results, selected thread header, encrypted status,
message bubbles, and composer.

## `src/index.css`

This file is deliberately tiny:

```css
@import "tailwindcss";
```

That line hands the stylesheet to Tailwind CSS v4. There are no hand-written
component selectors, no global button overrides, and no custom cascade fighting
the utility classes in `App.tsx`. The only global CSS entering the app is
Tailwind's generated output.

## `vite.config.ts`

The Vite config imports `tailwindcss` from `@tailwindcss/vite` and places
`tailwindcss()` beside `react()` in the plugin array. This follows Tailwind's
current Vite installation path. Vite sees the CSS import, Tailwind scans the
React source for utility classes, and the production build emits only the
utilities the app uses.

## Tailwind UI Model

The Instagram Direct-inspired visual language now lives directly in JSX
classNames. The auth page uses Tailwind grid, border, shadow, spacing, and
gradient utilities to create the phone preview and login card. The chat shell
uses responsive grid utilities for the desktop two-column layout and mobile
single-panel layout.

Conversation rows use fixed Tailwind grid tracks like
`grid-cols-[52px_minmax(0,1fr)_auto]` so avatars, names, handles, and presence
dots do not shift. Message bubbles use max-width utilities, rounded corners,
conditional colors, and `break-words` so long text does not break the viewport.
Because every visual decision is a utility class, changing the UI means editing
the component at the exact place where the element is rendered.

## Mental Model

Think of WhisperBox as three layers. The UI layer handles forms, lists, and
message bubbles. The API layer moves authenticated JSON to and from the server.
The crypto layer decides what the server is allowed to see. The app is correct
only when plaintext crosses from UI to crypto and becomes ciphertext before it
crosses from crypto to API.

The backend stores identity and delivery data. It does not have the private key,
the AES-GCM message key, the password-derived wrapping key, or plaintext
message content. If a payload cannot be decrypted locally, the app treats that
as a local rendering failure rather than asking the backend for help, because
the backend cannot help without breaking the E2EE design.
