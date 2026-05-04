import {
  AlertCircle,
  ArrowLeft,
  CheckCheck,
  LockKeyhole,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getConversations,
  getMessages,
  getPublicKey,
  loginUser,
  logout,
  refreshSession,
  registerUser,
  searchUsers,
  sendMessageFallback,
} from "./lib/api";
import { decryptMessagePayload, encryptMessageForUsers } from "./lib/crypto";
import { loadSession } from "./lib/sessionStore";
import type {
  Conversation,
  DecryptedMessage,
  MessageResponse,
  PublicUser,
  SessionRecord,
} from "./lib/types";
import { WhisperSocket } from "./lib/websocket";

type View = "login" | "register" | "chat";
type Toast = { tone: "info" | "error"; text: string } | null;

const emptyConversation: Conversation | null = null;
const iconButton =
  "grid h-10 w-10 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-neutral-950 transition duration-200 ease-out hover:scale-105 hover:bg-neutral-100 active:scale-95";
const avatarClass =
  "grid h-13 w-13 shrink-0 place-items-center rounded-full border-2 border-white bg-[linear-gradient(#fff,#fff)_padding-box,linear-gradient(135deg,#f58529,#dd2a7b,#8134af,#515bd4)_border-box] font-black text-white shadow-[inset_0_0_0_999px_rgba(17,24,39,0.74)]";
const inputClass =
  "h-11 w-full rounded border border-neutral-300 bg-neutral-50 px-3 text-sm outline-none focus:border-neutral-400";

export default function App() {
  const [view, setView] = useState<View>("login");
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(emptyConversation);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [socketStatus, setSocketStatus] = useState<"connecting" | "online" | "offline">("offline");
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const socketRef = useRef<WhisperSocket | null>(null);

  const activeName = selected?.display_name ?? "WhisperBox";
  const visibleMessages = useMemo(
    () => [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [messages],
  );

  const handleLogout = useCallback(async () => {
    socketRef.current?.close();
    if (session) await logout(session);
    setSession(null);
    setPrivateKey(null);
    setSelected(null);
    setMessages([]);
    setConversations([]);
    setView("login");
  }, [session]);

  const decryptForCurrentUser = useCallback(
    async (message: MessageResponse): Promise<DecryptedMessage> => {
      if (!session || !privateKey) {
        return { ...message, text: "Unable to decrypt message", decryptable: false };
      }

      try {
        const keySlot = message.from_user_id === session.user.id ? "sender" : "recipient";
        const text = await decryptMessagePayload(message.payload, privateKey, keySlot);
        return { ...message, text, decryptable: true };
      } catch {
        return { ...message, text: "Unable to decrypt message", decryptable: false };
      }
    },
    [privateKey, session],
  );

  const receiveRealtimeMessage = useCallback(
    async (message: MessageResponse) => {
      const decrypted = await decryptForCurrentUser(message);
      setMessages((current) => [...current.filter((item) => item.id !== message.id), decrypted]);
      if (session) void loadConversations(session);
    },
    [decryptForCurrentUser, session],
  );

  const loadThread = useCallback(
    async (conversation: Conversation) => {
      if (!session || !privateKey) return;
      setBusy(true);
      try {
        const encrypted = await getMessages(session.accessToken, conversation.user_id);
        const decrypted = await Promise.all(encrypted.map(decryptForCurrentUser));
        setMessages(decrypted);
      } catch (error) {
        setToast({ tone: "error", text: readableError(error) });
      } finally {
        setBusy(false);
      }
    },
    [decryptForCurrentUser, privateKey, session],
  );

  useEffect(() => {
    loadSession()
      .then((record) => {
        if (record) {
          setSession(record);
          setView("login");
          setToast({
            tone: "info",
            text: "Session found. Enter your password to unlock messages.",
          });
        }
      })
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!session || !privateKey) return;
    void loadConversations(session);
    const socket = new WhisperSocket(session, {
      onMessage: (message) => void receiveRealtimeMessage(message),
      onPresence: (userId, online) => {
        setOnlineUsers((current) => {
          const next = new Set(current);
          if (online) next.add(userId);
          else next.delete(userId);
          return next;
        });
      },
      onError: (text) => setToast({ tone: "error", text }),
      onSession: setSession,
      onAuthExpired: () => void handleLogout(),
      onStatus: setSocketStatus,
    });
    socketRef.current = socket;
    socket.connect();

    return () => socket.close();
  }, [handleLogout, privateKey, receiveRealtimeMessage, session]);

  useEffect(() => {
    if (!session) return;
    const handle = window.setTimeout(async () => {
      try {
        const refreshed = await refreshSession(session);
        setSession(refreshed);
        socketRef.current?.updateSession(refreshed);
      } catch {
        await handleLogout();
      }
    }, Math.max(10_000, session.accessTokenExpiresAt - Date.now() - 60_000));

    return () => window.clearTimeout(handle);
  }, [handleLogout, session]);

  useEffect(() => {
    if (!session || !privateKey || !selected) return;
    void loadThread(selected);
  }, [loadThread, privateKey, selected, session]);

  useEffect(() => {
    if (!session) return;
    const handle = window.setTimeout(async () => {
      try {
        setResults(await searchUsers(session.accessToken, query));
      } catch (error) {
        setToast({ tone: "error", text: readableError(error) });
      }
    }, 220);

    return () => window.clearTimeout(handle);
  }, [query, session]);

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const password = String(form.get("password") ?? "");

    setAuthBusy(true);
    setToast({ tone: "info", text: "Generating your encryption keys on this device." });

    try {
      const result = await registerUser({ username, displayName, password });
      setSession(result.session);
      setPrivateKey(result.privateKey);
      setView("chat");
      setToast({ tone: "info", text: "Vault created. Plaintext stays on your device." });
    } catch (error) {
      setToast({ tone: "error", text: readableError(error) });
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");

    setAuthBusy(true);
    setToast({ tone: "info", text: "Unlocking your private key in memory." });

    try {
      const result = await loginUser({ username, password });
      setSession(result.session);
      setPrivateKey(result.privateKey);
      setView("chat");
      setToast({ tone: "info", text: "Encryption key unlocked for this session." });
    } catch (error) {
      setToast({ tone: "error", text: readableError(error) });
    } finally {
      setAuthBusy(false);
    }
  }

  async function loadConversations(activeSession: SessionRecord) {
    try {
      setConversations(await getConversations(activeSession.accessToken));
    } catch (error) {
      setToast({ tone: "error", text: readableError(error) });
    }
  }

  async function startConversation(user: PublicUser) {
    const conversation = {
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      last_message_at: new Date().toISOString(),
    };
    setSelected(conversation);
    setConversations((current) => [
      conversation,
      ...current.filter((item) => item.user_id !== user.id),
    ]);
    setQuery("");
    setResults([]);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selected || !draft.trim()) return;

    const text = draft.trim();
    const optimisticId = crypto.randomUUID();
    setDraft("");

    try {
      const recipientPublicKey = await getPublicKey(session.accessToken, selected.user_id);
      const payload = await encryptMessageForUsers(
        text,
        recipientPublicKey,
        session.user.public_key,
      );
      const optimistic: DecryptedMessage = {
        id: optimisticId,
        from_user_id: session.user.id,
        to_user_id: selected.user_id,
        payload,
        created_at: new Date().toISOString(),
        delivered: false,
        decryptable: true,
        optimistic: true,
        text,
      };
      setMessages((current) => [...current, optimistic]);

      const sentOverSocket = socketRef.current?.send(selected.user_id, payload) ?? false;
      const stored = sentOverSocket
        ? optimistic
        : await sendMessageFallback(session.accessToken, selected.user_id, payload);

      setMessages((current) =>
        current.map((item) =>
          item.id === optimisticId
            ? { ...stored, text, decryptable: true, delivered: true }
            : item,
        ),
      );
      void loadConversations(session);
    } catch (error) {
      setMessages((current) =>
        current.map((item) =>
          item.id === optimisticId ? { ...item, failed: true, delivered: false } : item,
        ),
      );
      setToast({ tone: "error", text: readableError(error) });
    }
  }

  if (booting) {
    return <Splash />;
  }

  if (view !== "chat" || !session || !privateKey) {
    return (
      <AuthShell
        mode={view}
        busy={authBusy}
        toast={toast}
        onLogin={handleLogin}
        onRegister={handleRegister}
        onMode={setView}
      />
    );
  }

  return (
    <main className="min-h-screen bg-white text-neutral-950 md:grid md:grid-cols-[390px_minmax(0,1fr)]">
      <aside
        className={`min-h-screen flex-col border-r border-neutral-300 bg-white md:flex ${
          selected ? "hidden md:flex" : "flex"
        }`}
      >
        <header className="flex min-h-19 items-center justify-between gap-3 border-b border-neutral-200 px-5 py-3.5">
          <div>
            <p className="m-0 text-xs font-extrabold tracking-normal text-neutral-500 uppercase">
              WhisperBox
            </p>
            <h1 className="m-0 text-[22px] font-bold">{session.user.display_name}</h1>
          </div>
          <button className={iconButton} aria-label="Log out" onClick={() => void handleLogout()}>
            <LogOut size={19} />
          </button>
        </header>

        <label className="mx-4 mt-4 mb-2 flex items-center gap-2.5 rounded-[10px] border border-transparent bg-neutral-100 px-3.5 text-neutral-500 focus-within:border-neutral-400">
          <Search size={18} />
          <input
            className="h-11 w-full border-0 bg-transparent outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
          />
        </label>

        {query.trim().length > 0 ? (
          <section className="grid gap-1 p-3">
            <p className="m-0 px-2 pb-2 text-xs font-extrabold tracking-normal text-neutral-500 uppercase">
              People
            </p>
            {results.map((user) => (
              <button
                className="grid min-h-18 w-full cursor-pointer grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border-0 bg-transparent p-2.5 text-left transition duration-200 ease-out hover:scale-[1.01] hover:bg-neutral-100 active:scale-[0.99]"
                key={user.id}
                onClick={() => void startConversation(user)}
              >
                <Avatar name={user.display_name} />
                <span className="grid min-w-0">
                  <strong className="overflow-hidden text-[15px] text-ellipsis whitespace-nowrap">
                    {user.display_name}
                  </strong>
                  <small className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-neutral-500">
                    @{user.username}
                  </small>
                </span>
                <UserPlus size={18} />
              </button>
            ))}
            {results.length === 0 && <EmptyLine text="No users yet" />}
          </section>
        ) : (
          <section className="grid gap-1 p-3">
            <p className="m-0 px-2 pb-2 text-xs font-extrabold tracking-normal text-neutral-500 uppercase">
              Messages
            </p>
            {conversations.map((conversation) => (
              <button
                className={`grid min-h-18 w-full cursor-pointer grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border-0 bg-transparent p-2.5 text-left transition duration-200 ease-out hover:scale-[1.01] hover:bg-neutral-100 active:scale-[0.99] ${
                  selected?.user_id === conversation.user_id ? "bg-neutral-100" : ""
                }`}
                key={conversation.user_id}
                onClick={() => setSelected(conversation)}
              >
                <Avatar name={conversation.display_name} />
                <span className="grid min-w-0">
                  <strong className="overflow-hidden text-[15px] text-ellipsis whitespace-nowrap">
                    {conversation.display_name}
                  </strong>
                  <small className="overflow-hidden text-[13px] text-ellipsis whitespace-nowrap text-neutral-500">
                    @{conversation.username}
                  </small>
                </span>
                {onlineUsers.has(conversation.user_id) && (
                  <i className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                )}
              </button>
            ))}
            {conversations.length === 0 && <EmptyLine text="Search for someone to begin" />}
          </section>
        )}
      </aside>

      <section
        className={`min-h-screen min-w-0 flex-col bg-white md:flex ${
          selected ? "flex" : "hidden md:flex"
        }`}
      >
        {selected ? (
          <>
            <header className="flex min-h-19 items-center gap-3.5 border-b border-neutral-200 px-5 py-3.5">
              <button className={`${iconButton} md:hidden`} onClick={() => setSelected(null)}>
                <ArrowLeft size={20} />
              </button>
              <Avatar name={activeName} />
              <div className="grid min-w-0 flex-1">
                <h2 className="m-0 overflow-hidden text-[17px] font-bold text-ellipsis whitespace-nowrap">
                  {activeName}
                </h2>
                <p className="m-0 flex items-center gap-1.5 text-xs font-bold text-neutral-500">
                  <LockKeyhole size={13} />
                  End-to-end encrypted
                </p>
              </div>
              <StatusPill status={socketStatus} />
              <button className={iconButton} aria-label="More">
                <MoreHorizontal size={20} />
              </button>
            </header>

            <div className="flex flex-1 flex-col gap-2 overflow-auto bg-[radial-gradient(circle_at_top_left,rgba(245,133,41,0.16),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(81,91,212,0.14),transparent_34%),linear-gradient(rgba(255,255,255,0.95),rgba(255,255,255,0.95))] px-3.5 py-5 md:px-11">
              {busy && <EmptyLine text="Decrypting messages" />}
              {!busy &&
                visibleMessages.map((message) => {
                  const mine = message.from_user_id === session.user.id;
                  return (
                    <article className={`flex ${mine ? "justify-end" : ""}`} key={message.id}>
                      <div
                        className={`max-w-[88%] overflow-wrap-anywhere rounded-[22px] px-3.5 pt-2.5 pb-2 shadow-[0_8px_30px_rgba(15,23,42,0.04)] md:max-w-[min(620px,78%)] ${
                          !message.decryptable
                            ? "border border-red-200 bg-red-50 text-red-800"
                            : mine
                              ? "border-0 bg-[#3797f0] text-white"
                              : "border border-neutral-200 bg-white text-neutral-950"
                        }`}
                      >
                        <p className="m-0 break-words">{message.text}</p>
                        <span
                          className={`mt-1 flex items-center gap-1 text-[11px] font-extrabold ${
                            mine && message.decryptable ? "text-white/80" : "text-neutral-500"
                          }`}
                        >
                          {message.failed ? (
                            <>
                              <AlertCircle size={12} /> failed
                            </>
                          ) : (
                            <>
                              <CheckCheck size={12} /> encrypted
                            </>
                          )}
                        </span>
                      </div>
                    </article>
                  );
                })}
              {!busy && visibleMessages.length === 0 && (
                <div className="grid flex-1 place-items-center content-center gap-2.5 text-center text-neutral-500">
                  <ShieldCheck size={34} />
                  <h3 className="m-0 text-lg font-bold text-neutral-950">Private room created</h3>
                  <p className="m-0">Messages are encrypted before they leave this browser.</p>
                </div>
              )}
            </div>

            <form
              className="grid grid-cols-[minmax(0,1fr)_44px] gap-2.5 border-t border-neutral-200 px-5 pt-4 pb-5"
              onSubmit={sendMessage}
            >
              <input
                className="h-11 w-full rounded-full border border-neutral-300 bg-white px-4.5 outline-none focus:border-neutral-400"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Message..."
              />
              <button
                className="grid h-11 w-11 cursor-pointer place-items-center rounded-full border-0 bg-[#0095f6] text-white transition duration-200 ease-out hover:scale-105 hover:bg-[#1877f2] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                disabled={!draft.trim()}
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            </form>
          </>
        ) : (
          <div className="grid flex-1 place-items-center content-center gap-2.5 text-center text-neutral-500">
            <MessageCircle size={56} />
            <h2 className="m-0 text-xl font-bold text-neutral-950">Your messages</h2>
            <p className="m-0">Search for a user and start an encrypted conversation.</p>
          </div>
        )}
      </section>

      {toast && (
        <div
          className={`fixed right-4 bottom-4 flex max-w-[calc(100vw-36px)] items-center gap-2 rounded-xl border px-3.5 py-3 text-sm font-bold shadow-[0_18px_50px_rgba(15,23,42,0.14)] md:max-w-[430px] ${
            toast.tone === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-neutral-300 bg-white text-neutral-950"
          }`}
        >
          {toast.tone === "error" ? <AlertCircle size={17} /> : <Sparkles size={17} />}
          {toast.text}
        </div>
      )}
    </main>
  );
}

function Splash() {
  return (
    <main className="grid min-h-screen place-items-center content-center gap-4 bg-white">
      <div className="grid h-[74px] w-[74px] place-items-center rounded-[20px] bg-[radial-gradient(circle_at_30%_107%,#fdf497_0_5%,#fd5949_45%,transparent_46%),linear-gradient(135deg,#833ab4,#fd1d1d_48%,#fcb045)] text-white shadow-[0_24px_60px_rgba(193,53,132,0.24)]">
        <LockKeyhole size={30} />
      </div>
      <h1 className="m-0 text-[26px] font-bold">WhisperBox</h1>
    </main>
  );
}

function AuthShell(props: {
  mode: View;
  busy: boolean;
  toast: Toast;
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
  onRegister: (event: FormEvent<HTMLFormElement>) => void;
  onMode: (mode: View) => void;
}) {
  const register = props.mode === "register";

  return (
    <main className="grid min-h-screen grid-cols-1 items-center justify-center gap-14 bg-[radial-gradient(circle_at_18%_18%,rgba(253,29,29,0.16),transparent_30%),radial-gradient(circle_at_68%_72%,rgba(131,58,180,0.16),transparent_28%),linear-gradient(145deg,rgba(250,250,250,0.94),rgba(255,255,255,0.98))] px-3.5 py-6 text-neutral-950 md:grid-cols-[minmax(320px,0.9fr)_minmax(340px,430px)] md:p-11">
      <section className="hidden justify-end md:flex">
        <div className="relative aspect-[9/16] w-[min(330px,80vw)] overflow-hidden rounded-[42px] border-[10px] border-slate-800 bg-white px-4.5 py-7 shadow-[0_36px_90px_rgba(15,23,42,0.25)]">
          <div className="flex items-center gap-2.5 border-b border-neutral-200 pb-4.5">
            <span className="h-9.5 w-9.5 rounded-full bg-linear-135 from-[#fd5949] to-[#833ab4]" />
            <p className="m-0 text-sm font-bold text-neutral-500">ciphertext only</p>
          </div>
          <div className="mt-6 h-14 w-3/4 rounded-3xl bg-neutral-100" />
          <div className="mt-6 ml-auto h-14 w-3/4 rounded-3xl bg-linear-135 from-[#0095f6] to-[#6d5dfc]" />
          <div className="mt-6 h-14 w-1/2 rounded-3xl bg-neutral-100" />
        </div>
      </section>

      <section className="grid gap-3">
        <form
          className="grid gap-4 border border-neutral-300 bg-white p-8 text-center"
          onSubmit={register ? props.onRegister : props.onLogin}
        >
          <LockKeyhole size={34} />
          <h1 className="m-0 font-serif text-[38px] font-bold">WhisperBox</h1>
          <p className="m-0 mb-2 font-bold text-neutral-500">
            End-to-end encrypted direct messages.
          </p>

          {register && (
            <>
              <label className="grid gap-1.5 text-left text-[13px] font-bold text-neutral-600">
                Display name
                <input className={inputClass} name="displayName" minLength={1} maxLength={64} required />
              </label>
            </>
          )}
          <label className="grid gap-1.5 text-left text-[13px] font-bold text-neutral-600">
            Username
            <input
              className={inputClass}
              name="username"
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_-]+"
              required
            />
          </label>
          <label className="grid gap-1.5 text-left text-[13px] font-bold text-neutral-600">
            Password
            <input
              className={inputClass}
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <button
            className="mt-1.5 h-11 cursor-pointer rounded-lg border-0 bg-[#0095f6] font-extrabold text-white transition duration-200 ease-out hover:scale-[1.01] hover:bg-[#1877f2] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
            disabled={props.busy}
          >
            {props.busy ? "Working..." : register ? "Create account" : "Log in"}
          </button>
        </form>

        <div className="flex justify-center gap-1.5 border border-neutral-300 bg-white p-5 text-sm">
          {register ? "Have an account?" : "New here?"}
          <button
            className="cursor-pointer border-0 bg-transparent font-extrabold text-[#0095f6] transition duration-200 ease-out hover:scale-105 hover:text-[#1877f2] active:scale-95"
            onClick={() => props.onMode(register ? "login" : "register")}
          >
            {register ? "Log in" : "Create account"}
          </button>
        </div>

        {props.toast && (
          <div
            className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-sm font-bold ${
              props.toast.tone === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-neutral-300 bg-white text-neutral-950"
            }`}
          >
            {props.toast.tone === "error" ? <AlertCircle size={17} /> : <ShieldCheck size={17} />}
            {props.toast.text}
          </div>
        )}
      </section>
    </main>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div className={avatarClass} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "W"}
    </div>
  );
}

function StatusPill({ status }: { status: "connecting" | "online" | "offline" }) {
  const tone =
    status === "online"
      ? "bg-emerald-100 text-emerald-700"
      : status === "connecting"
        ? "bg-amber-100 text-amber-800"
        : "bg-red-100 text-red-800";

  return (
    <span className={`hidden rounded-full px-2.5 py-1 text-xs font-black capitalize md:inline ${tone}`}>
      {status}
    </span>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="m-0 text-neutral-500">{text}</p>;
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
