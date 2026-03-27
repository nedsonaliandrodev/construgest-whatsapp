const express = require("express");
const cors = require("cors");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "construgest-wa-secret";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://construgest.vercel.app,http://localhost:3000").split(",");

// CORS
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// Auth middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// State
const AUTH_DIR = path.join(process.cwd(), ".wa-auth");
const state = {
  status: "disconnected", // disconnected | connecting | qr | connected
  qr: null,               // raw QR string
  qrDataUrl: null,         // QR as data URL image
  socket: null,
  retryCount: 0,
  phone: null,
};

async function connectWhatsApp(isRetry = false) {
  // Only block duplicate calls from the API, not from internal retries
  if (!isRetry && (state.status === "connected" || state.status === "connecting")) {
    console.log(`[WA] Already ${state.status}, returning current state`);
    return { status: state.status, qr: state.qrDataUrl };
  }

  // Clean up previous socket if any
  if (state.socket) {
    try {
      state.socket.ev.removeAllListeners("connection.update");
      state.socket.ev.removeAllListeners("creds.update");
      state.socket.end(undefined);
    } catch (e) {
      console.log("[WA] Cleanup previous socket:", e.message);
    }
    state.socket = null;
  }

  state.status = "connecting";
  state.qr = null;
  state.qrDataUrl = null;
  console.log(`[WA] Connecting... (retry: ${isRetry}, attempt: ${state.retryCount})`);

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const hasCreds = authState.creds?.registered;
    console.log(`[WA] Baileys version: ${version.join(".")}, hasCreds: ${hasCreds}`);

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, console),
      },
      printQRInTerminal: true,
      browser: ["ConstruGest", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
    });

    state.socket = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log("[WA] connection.update:", JSON.stringify({ connection, qr: !!qr, hasLastDisconnect: !!lastDisconnect }));

      if (qr) {
        state.status = "qr";
        state.qr = qr;
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch (e) {
          console.error("[WA] QR generation error:", e);
        }
        console.log("[WA] QR code generated, waiting for scan...");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || "unknown";
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed. Code: ${statusCode}, Reason: ${errorMsg}, LoggedOut: ${loggedOut}`);

        state.socket = null;
        state.qr = null;
        state.qrDataUrl = null;
        state.phone = null;

        if (loggedOut) {
          state.status = "disconnected";
          state.retryCount = 0;
          const fs = require("fs");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log("[WA] Auth files cleaned after logout");
          }
        } else if (state.retryCount < 5) {
          state.retryCount++;
          // Keep as "connecting" so frontend keeps polling
          state.status = "connecting";
          console.log(`[WA] Will reconnect in 3s... attempt ${state.retryCount}/5`);
          setTimeout(() => connectWhatsApp(true), 3000);
        } else {
          state.status = "disconnected";
          state.retryCount = 0;
          console.log("[WA] Max retries (5) reached, giving up");
        }
      }

      if (connection === "open") {
        state.status = "connected";
        state.qr = null;
        state.qrDataUrl = null;
        state.retryCount = 0;
        state.phone = sock.user?.id?.split(":")[0] || null;
        console.log(`[WA] Connected! Phone: ${state.phone}`);
      }
    });

    sock.ev.on("creds.update", async () => {
      console.log("[WA] Credentials updated, saving...");
      await saveCreds();
      console.log("[WA] Credentials saved to disk");
    });

    return { status: state.status };
  } catch (err) {
    console.error("[WA] Connect error:", err);
    state.status = "disconnected";
    return { status: "disconnected", error: err.message };
  }
}

// Routes
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/status", auth, (req, res) => {
  res.json({
    status: state.status,
    qr: state.qrDataUrl,
    phone: state.phone,
  });
});

app.post("/connect", auth, async (req, res) => {
  const result = await connectWhatsApp();
  res.json(result);
});

app.post("/disconnect", auth, async (req, res) => {
  try {
    if (state.socket) {
      await state.socket.logout();
      state.socket = null;
    }
    state.status = "disconnected";
    state.qr = null;
    state.qrDataUrl = null;
    state.phone = null;
    state.retryCount = 0;
    res.json({ ok: true });
  } catch (err) {
    console.error("[WA] Disconnect error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", auth, async (req, res) => {
  if (state.status !== "connected" || !state.socket) {
    return res.status(400).json({ error: "WhatsApp not connected" });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message required" });
  }

  try {
    // Format phone: remove +, add @s.whatsapp.net
    const jid = phone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    await state.socket.sendMessage(jid, { text: message });
    res.json({ ok: true, to: jid });
  } catch (err) {
    console.error("[WA] Send error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[WA Server] Running on port ${PORT}`);
  console.log(`[WA Server] Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
