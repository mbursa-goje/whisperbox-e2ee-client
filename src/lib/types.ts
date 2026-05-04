export type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  public_key: string;
  wrapped_private_key: string;
  pbkdf2_salt: string;
  created_at: string;
};

export type PublicUser = {
  id: string;
  username: string;
  display_name: string;
};

export type AuthResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  user: UserProfile;
};

export type MessagePayload = {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  encryptedKeyForSelf: string;
};

export type MessageResponse = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  payload: MessagePayload;
  delivered?: boolean;
  created_at: string;
};

export type Conversation = {
  user_id: string;
  display_name: string;
  username: string;
  last_message_at: string;
};

export type SessionRecord = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  user: UserProfile;
};

export type DecryptedMessage = MessageResponse & {
  text: string;
  decryptable: boolean;
  optimistic?: boolean;
  failed?: boolean;
};
