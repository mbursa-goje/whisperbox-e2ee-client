import { API_BASE_URL, refreshSession } from "./api";
import type { MessageResponse, SessionRecord } from "./types";

type WhisperSocketHandlers = {
  onMessage: (message: MessageResponse) => void;
  onPresence: (userId: string, online: boolean) => void;
  onError: (message: string) => void;
  onSession: (session: SessionRecord) => void;
  onAuthExpired: () => void;
  onStatus: (status: "connecting" | "online" | "offline") => void;
};

export class WhisperSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;

  constructor(
    private session: SessionRecord,
    private handlers: WhisperSocketHandlers,
  ) {}

  connect() {
    this.handlers.onStatus("connecting");
    const wsBase = API_BASE_URL.replace("https://", "wss://").replace(
      "http://",
      "ws://",
    );
    this.socket = new WebSocket(
      `${wsBase}/ws?token=${encodeURIComponent(this.session.accessToken)}`,
    );
    this.socket.onopen = () => this.handlers.onStatus("online");
    this.socket.onmessage = (event) => this.handleFrame(event.data);
    this.socket.onerror = () => this.handlers.onError("Realtime channel failed");
    this.socket.onclose = (event) => this.handleClose(event.code);
  }

  updateSession(session: SessionRecord) {
    this.session = session;
  }

  send(to: string, payload: MessageResponse["payload"]): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ event: "message.send", to, payload }));
    return true;
  }

  close() {
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.handlers.onStatus("offline");
  }

  private handleFrame(raw: string) {
    try {
      const frame = JSON.parse(raw) as {
        event?: string;
        detail?: string;
        user_id?: string;
      } & MessageResponse;

      if (frame.event === "message.receive") {
        this.handlers.onMessage(frame);
      } else if (frame.event === "user.online" && frame.user_id) {
        this.handlers.onPresence(frame.user_id, true);
      } else if (frame.event === "user.offline" && frame.user_id) {
        this.handlers.onPresence(frame.user_id, false);
      } else if (frame.event === "error") {
        this.handlers.onError(frame.detail ?? "Realtime error");
      }
    } catch {
      this.handlers.onError("Received an unreadable realtime event");
    }
  }

  private async handleClose(code: number) {
    this.handlers.onStatus("offline");

    if (code === 1000) return;

    if (code === 4003) {
      this.handlers.onAuthExpired();
      return;
    }

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

    this.reconnectTimer = window.setTimeout(() => this.connect(), 2200);
  }
}
