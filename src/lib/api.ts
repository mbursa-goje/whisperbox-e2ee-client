import { createRegistrationKeyBundle, unlockPrivateKey } from "./crypto";
import { clearSession, saveSession } from "./sessionStore";
import type {
  AuthResponse,
  Conversation,
  MessagePayload,
  MessageResponse,
  PublicUser,
  SessionRecord,
  UserProfile,
} from "./types";

export const API_BASE_URL = "https://whisperbox.koyeb.app";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  accessToken?: string;
};

export async function registerUser(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<{ session: SessionRecord; privateKey: CryptoKey }> {
  const bundle = await createRegistrationKeyBundle(input.password);
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
  const session = toSession(response);
  await saveSession(session);

  return { session, privateKey: bundle.privateKey };
}

export async function loginUser(input: {
  username: string;
  password: string;
}): Promise<{ session: SessionRecord; privateKey: CryptoKey }> {
  const response = await request<AuthResponse>("/auth/login", {
    method: "POST",
    body: input,
  });
  const privateKey = await unlockPrivateKey(
    input.password,
    response.user.wrapped_private_key,
    response.user.pbkdf2_salt,
  );
  const session = toSession(response);
  await saveSession(session);

  return { session, privateKey };
}

export async function refreshSession(
  session: SessionRecord,
): Promise<SessionRecord> {
  const response = await request<{
    access_token: string;
    token_type: "bearer";
    expires_in: number;
  }>("/auth/refresh", {
    method: "POST",
    body: { refresh_token: session.refreshToken },
  });
  const refreshed = {
    ...session,
    accessToken: response.access_token,
    accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
  };
  await saveSession(refreshed);

  return refreshed;
}

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

export async function getMe(accessToken: string): Promise<UserProfile> {
  return request<UserProfile>("/auth/me", { accessToken });
}

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

export async function getConversations(
  accessToken: string,
): Promise<Conversation[]> {
  return request<Conversation[]>("/conversations", { accessToken });
}

export async function getMessages(
  accessToken: string,
  userId: string,
): Promise<MessageResponse[]> {
  return request<MessageResponse[]>(
    `/conversations/${userId}/messages?limit=50`,
    { accessToken },
  );
}

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

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    return `Request failed with status ${response.status}`;
  }

  return `Request failed with status ${response.status}`;
}

function toSession(response: AuthResponse): SessionRecord {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    accessTokenExpiresAt: Date.now() + response.expires_in * 1000,
    user: response.user,
  };
}
