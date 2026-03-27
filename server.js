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

async function connectWhatsApp() {
  if (state.status === "connected" || state.status === "connecting") {
    return { status: state.status, qr: state.qrDataUrl };
  }

  state.status = "connecting";
  state.qr = null;
  state.qrDataUrl = null;

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, console),
      },
      printQRInTerminal: true,
      browser: ["ConstruGest", "Chrome", "1.0.0"],
    });

    state.socket = sock;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.status = "qr";
        state.qr = qr;
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        } catch (e) {
          console.error("QR generation error:", e);
        }
        console.log("[WA] QR code generated");
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed. Code: ${code}. LoggedOut: ${loggedOut}`);

        state.socket = null;
        state.qr = null;
        state.qrDataUrl = null;
        state.phone = null;

        if (loggedOut) {
          state.status = "disconnected";
          state.retryCount = 0;
          // Clean auth files on logout
          const fs = require("fs");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
        } else if (state.retryCount < 5) {
          state.retryCount++;
          state.status = "connecting";
          console.log(`[WA] Reconnecting... attempt ${state.retryCount}`);
          setTimeout(connectWhatsApp, 3000);
        } else {
          state.status = "disconnected";
          state.retryCount = 0;
          console.log("[WA] Max retries reached");
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

    sock.ev.on("creds.update", saveCreds);

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
