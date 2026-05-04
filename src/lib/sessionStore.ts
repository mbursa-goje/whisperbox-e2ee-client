import type { SessionRecord } from "./types";

const DB_NAME = "whisperbox-client";
const STORE_NAME = "session";
const SESSION_KEY = "current";

let openRequest: Promise<IDBDatabase> | null = null;

export async function saveSession(record: SessionRecord): Promise<void> {
  const db = await openDatabase();
  await requestToPromise(
    db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(record, SESSION_KEY),
  );
}

export async function loadSession(): Promise<SessionRecord | null> {
  const db = await openDatabase();
  const record = await requestToPromise<SessionRecord | undefined>(
    db.transaction(STORE_NAME).objectStore(STORE_NAME).get(SESSION_KEY),
  );

  return record ?? null;
}

export async function clearSession(): Promise<void> {
  const db = await openDatabase();
  await requestToPromise(
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(SESSION_KEY),
  );
}

function openDatabase(): Promise<IDBDatabase> {
  openRequest ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return openRequest;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
