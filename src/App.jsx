import { useState, useEffect, useRef, useCallback } from "react";
const STORAGE_KEY = "groq_conversations";
const MODEL = "llama-3.3-70b-versatile";

function loadConversations() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveConversations(convs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
}
function uid() { return Math.random().toString(36).slice(2); }
function getTitle(messages) {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "Nouvelle discussion";
  return first.content.slice(0, 40) + (first.content.length > 40 ? "…" : "");
}

// ── Set page title + favicon ─────────────────────────────────────────────────


function inlineFormat(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code class='inline-code'>$1</code>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function renderMarkdown(text) {
  const lines = text.split("\n");
  const html = [];
  let inCode = false, codeLang = "", codeLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (!inCode) { inCode = true; codeLang = line.slice(3).trim(); codeLines = []; }
      else {
        const escaped = codeLines.join("\n").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        html.push(
          '<div class="code-block">' +
          '<div class="code-header">' +
          '<span class="code-lang">' + (codeLang || "code") + "</span>" +
          '<button class="copy-btn" onclick="copyCode(this)">Copier</button>' +
          "</div><pre><code>" + escaped + "</code></pre></div>"
        );
        inCode = false; codeLang = ""; codeLines = [];
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (line.startsWith("### ")) html.push("<h3>" + inlineFormat(line.slice(4)) + "</h3>");
    else if (line.startsWith("## ")) html.push("<h2>" + inlineFormat(line.slice(3)) + "</h2>");
    else if (line.startsWith("# ")) html.push("<h1>" + inlineFormat(line.slice(2)) + "</h1>");
    else if (line.startsWith("- ") || line.startsWith("* ")) html.push("<li>" + inlineFormat(line.slice(2)) + "</li>");
    else if (/^\d+\.\s/.test(line)) html.push("<li>" + inlineFormat(line.replace(/^\d+\.\s/, "")) + "</li>");
    else if (line.trim() === "") html.push("<br/>");
    else html.push("<p>" + inlineFormat(line) + "</p>");
  }
  return html.join("").replace(/(<li>[\s\S]*?<\/li>)+/g, (m) => "<ul>" + m + "</ul>");
}

// ── Streaming Groq API ───────────────────────────────────────────────────────
async function callGroqStream(apiKey, history, userMessage, onChunk, onDone, onError) {
  const messages = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));
  messages.push({ role: "user", content: userMessage });
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 1024, stream: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err?.error?.message) || "Erreur API Groq (" + res.status + ")");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) { full += delta; onChunk(full); }
        } catch { }
      }
    }
    onDone(full || "Aucune réponse reçue.");
  } catch (err) { onError(err.message); }
}

// ── Notification sound ───────────────────────────────────────────────────────
function playNotifSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.35);
  } catch { }
}

// ── Export conversation ──────────────────────────────────────────────────────
function exportConversation(conv) {
  if (!conv || conv.messages.length === 0) return;
  const title = getTitle(conv.messages);
  const lines = ["=== " + title + " ===", "Exporté le " + new Date().toLocaleString("fr-FR"), ""];
  conv.messages.forEach((m) => {
    lines.push((m.role === "user" ? "Vous" : "Assistant") + " :");
    lines.push(m.content); lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = title.slice(0, 30).replace(/\s+/g, "_") + ".txt";
  a.click(); URL.revokeObjectURL(url);
}

// ── SVG Icons ────────────────────────────────────────────────────────────────
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M22 2L11 13" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ExportIcon = ({ color = "currentColor" }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <polyline points="7 10 12 15 17 10" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <line x1="12" y1="15" x2="12" y2="3" stroke={color} strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const TrashIcon = ({ color = "currentColor" }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polyline points="3 6 5 6 21 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M19 6L18.1 20.1C18 21.2 17.1 22 16 22H8C6.9 22 6 21.2 5.9 20.1L5 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M10 11V17" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    <path d="M14 11V17" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    <path d="M9 6V4C9 3.4 9.4 3 10 3H14C14.6 3 15 3.4 15 4V6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MenuIcon = ({ color = "currentColor" }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="3" y1="6" x2="21" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    <line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth="2" strokeLinecap="round"/>
    <line x1="3" y1="18" x2="21" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const RefreshIcon = ({ color = "currentColor" }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M23 4V10H17" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M20.49 15C19.84 16.8 18.61 18.33 17 19.37C15.39 20.42 13.48 20.9 11.57 20.73C9.65 20.56 7.86 19.74 6.46 18.42C5.07 17.1 4.15 15.36 3.84 13.47C3.54 11.57 3.87 9.63 4.77 7.94C5.67 6.25 7.1 4.91 8.83 4.11C10.56 3.32 12.5 3.12 14.35 3.54C16.2 3.96 17.86 4.97 19.07 6.43L23 10" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── TchatooLogo SVG ──────────────────────────────────────────────────────────
const TchatooLogo = ({ size = 28 }) => (
 <img 
    src="/src/assets/logo.png" 
    alt="Logo Tchatoo" 
    width={size} 
    height={size} 
    style={{ 
      objectFit: "contain",
      borderRadius: "8px" // Optionnel : pour arrondir légèrement les angles si besoin
    }} 
  />
);

// ── TypingIndicator ──────────────────────────────────────────────────────────
function TypingIndicator({ dark }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, animation: "fadeIn .3s ease" }}>
      <div style={{
        width: 32, height: 32, borderRadius: 10, flexShrink: 0,
        background: dark ? "linear-gradient(135deg,#2a1a0a,#1a0f05)" : "linear-gradient(135deg,#fff3e0,#ffe0b2)",
        border: dark ? "1px solid rgba(255,140,0,.15)" : "1px solid rgba(255,140,0,.25)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12.5, fontWeight: 700, color: dark ? "#ffb347" : "#e65c00",
        overflow: "hidden",
      }}>
        <TchatooLogo size={20} />
      </div>
      <div style={{
        background: dark ? "rgba(30,15,5,.8)" : "rgba(255,243,224,.85)",
        border: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.2)",
        borderRadius: "4px 18px 18px 18px", padding: "14px 18px",
        display: "flex", gap: 6, alignItems: "center",
      }}>
        {[0, 160, 320].map((d) => (
          <span key={d} style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%",
            background: "linear-gradient(135deg,#FFA500,#FF4500)",
            animation: "blink 1.4s infinite", animationDelay: d + "ms",
          }} />
        ))}
      </div>
    </div>
  );
}

// ── Message ──────────────────────────────────────────────────────────────────
function Message({ msg, dark, onRegenerate, isLast, isAssistant }) {
  const isUser = msg.role === "user";
  const [hovering, setHovering] = useState(false);

  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      flexDirection: isUser ? "row-reverse" : "row",
      animation: "fadeIn .35s cubic-bezier(.4,0,.2,1)",
    }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: 10, flexShrink: 0,
        background: isUser
          ? "linear-gradient(135deg,#FF8C00,#FF4500)"
          : dark ? "linear-gradient(135deg,#2a1a0a,#1a0f05)" : "linear-gradient(135deg,#fff3e0,#ffe0b2)",
        border: isUser
          ? "1px solid rgba(255,140,0,.4)"
          : dark ? "1px solid rgba(255,140,0,.15)" : "1px solid rgba(255,140,0,.25)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12.5, fontWeight: 700,
        color: isUser ? "#fff" : dark ? "#ffb347" : "#e65c00",
        overflow: "hidden",
      }}>
        {isUser ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 21V19C20 17.9 19.1 17 18 17H6C4.9 17 4 17.9 4 19V21" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            <circle cx="12" cy="9" r="4" stroke="white" strokeWidth="2"/>
          </svg>
        ) : <TchatooLogo size={20} />}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: "72%", alignItems: isUser ? "flex-end" : "flex-start" }}>
        <div style={{
          padding: "13px 17px", fontSize: 14, lineHeight: 1.7,
          border: isUser
            ? "1px solid rgba(255,140,0,.3)"
            : dark ? "1px solid rgba(255,140,0,.08)" : "1px solid rgba(255,140,0,.15)",
          boxShadow: isUser
            ? "0 4px 20px -8px rgba(255,100,0,.35)"
            : dark ? "0 4px 20px -8px rgba(0,0,0,.5)" : "0 4px 20px -8px rgba(0,0,0,.1)",
          background: isUser
            ? "linear-gradient(135deg,#FF8C00,#FF4500)"
            : dark ? "#18100a" : "#fff",
          color: isUser ? "#fff" : dark ? "#f0e8d8" : "#1a1a2e",
          borderRadius: isUser ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
        }}>
          {isUser
            ? <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
            : <div style={{ fontSize: 14, lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
          }
        </div>

        {isLast && isAssistant && onRegenerate && (
          <button
            onClick={onRegenerate}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
            title="Régénérer la réponse"
            style={{
              background: hovering ? "rgba(255,140,0,.08)" : "none",
              border: dark
                ? hovering ? "1px solid rgba(255,140,0,.3)" : "1px solid rgba(255,255,255,.08)"
                : hovering ? "1px solid rgba(255,140,0,.35)" : "1px solid rgba(0,0,0,.1)",
              borderRadius: 8, cursor: "pointer", fontSize: 11,
              color: hovering ? "#FFA500" : dark ? "#6a6a82" : "#9a9ab0",
              padding: "4px 10px", display: "flex", alignItems: "center", gap: 5,
              transition: "all .2s",
            }}
          >
            <RefreshIcon color={hovering ? "#FFA500" : dark ? "#6a6a82" : "#9a9ab0"} />
            Régénérer
          </button>
        )}
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey] = useState(import.meta.env.VITE_GEMINI_API_KEY || "");
  const [dark, setDark] = useState(true);
  const [conversations, setConversations] = useState(loadConversations);
  const [activeId, setActiveId] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [error, setError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  const activeConv = conversations.find((c) => c.id === activeId) || null;
  const messages = activeConv ? activeConv.messages : [];

  const filteredConvs = search.trim()
    ? conversations.filter((c) =>
        getTitle(c.messages).toLowerCase().includes(search.toLowerCase()) ||
        c.messages.some((m) => m.content.toLowerCase().includes(search.toLowerCase()))
      )
    : conversations;

  useEffect(() => { saveConversations(conversations); }, [conversations]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading, streamingContent]);

  // Page title + favicon


  // Body background
  useEffect(() => {
    document.body.style.background = dark
      ? "radial-gradient(1100px 700px at 15% -10%,#2d1200 0%,transparent 60%),radial-gradient(800px 600px at 100% 110%,#1a0800 0%,transparent 55%),#0a0501"
      : "radial-gradient(1100px 700px at 15% -10%,#fff3e0 0%,transparent 60%),radial-gradient(800px 600px at 100% 110%,#ffe0b2 0%,transparent 55%),#faf6f0";
    document.body.style.color = dark ? "#f0e8d8" : "#1a1208";
    document.body.style.transition = "background 0.35s ease,color 0.35s ease";
  }, [dark]);

  // Global CSS
  useEffect(() => {
    window.copyCode = (btn) => {
      const code = btn.closest(".code-block").querySelector("code").textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copié ✓";
        setTimeout(() => { btn.textContent = "Copier"; }, 2000);
      });
    };
    const existing = document.getElementById("tchatoo-global");
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.id = "tchatoo-global";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
      *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased;}
      html,body{height:100%;}
      body{font-family:'Inter',system-ui,sans-serif;}
      @keyframes blink{0%,80%,100%{opacity:.2;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
      @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
      @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,140,0,0)}50%{box-shadow:0 0 18px 3px rgba(255,100,0,.2)}}
      .code-block{border-radius:12px;overflow:hidden;margin:10px 0;background:#120800;border:1px solid rgba(255,140,0,.12);}
      .code-header{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:rgba(255,140,0,.04);border-bottom:1px solid rgba(255,140,0,.1);}
      .code-lang{font-size:11px;color:#FFA500;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.08em;}
      .copy-btn{background:rgba(255,140,0,.06);border:1px solid rgba(255,140,0,.15);color:#d4a060;font-size:11px;padding:4px 12px;border-radius:6px;cursor:pointer;transition:all .2s;font-family:'Inter',sans-serif;}
      .copy-btn:hover{background:rgba(255,140,0,.18);border-color:rgba(255,140,0,.4);color:#fff;}
      pre{padding:16px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.65;color:#d4c4a8;}
      code{font-family:'JetBrains Mono',monospace;}
      .inline-code{background:rgba(255,140,0,.1);padding:2px 7px;border-radius:5px;font-size:12.5px;color:#FFA500;border:1px solid rgba(255,140,0,.2);}
      h1,h2,h3{margin:14px 0 6px;font-weight:600;}
      h1{font-size:22px;}h2{font-size:18px;}h3{font-size:15px;}
      p{margin:6px 0;line-height:1.75;}
      ul{padding-left:22px;margin:6px 0;}
      li{margin:3px 0;}
      a{color:#FFA500;text-decoration:none;border-bottom:1px solid rgba(255,165,0,.3);}
      a:hover{color:#FFD700;}
      strong{font-weight:600;}
      ::-webkit-scrollbar{width:5px;height:5px;}
      ::-webkit-scrollbar-track{background:transparent;}
      ::-webkit-scrollbar-thumb{background:rgba(255,140,0,.15);border-radius:10px;}
      ::-webkit-scrollbar-thumb:hover{background:rgba(255,140,0,.4);}
      textarea{font-family:inherit;}
      textarea::placeholder{color:#7a6040;}
      button{transition:all .2s cubic-bezier(.4,0,.2,1);}
      .streaming-cursor::after{content:'▋';display:inline-block;animation:blink 1s infinite;color:#FFA500;margin-left:2px;}
      input[type=text]::placeholder{color:#7a6040;}
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("tchatoo-global")?.remove(); };
  }, []);

  const newConversation = useCallback(() => {
    const conv = { id: uid(), messages: [], createdAt: Date.now() };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id); setError(null); setSearch("");
  }, []);

  function deleteConversation(id, e) {
    e.stopPropagation();
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  async function sendMessage(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    setError(null);
    let convId = activeId;
    let currentConvs = conversations;
    if (!convId) {
      const conv = { id: uid(), messages: [], createdAt: Date.now() };
      currentConvs = [conv, ...conversations];
      setConversations(currentConvs);
      convId = conv.id; setActiveId(convId);
    }
    const userMsg = { role: "user", content: text, id: uid() };
    const updatedConvs = currentConvs.map((c) =>
      c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c
    );
    setConversations(updatedConvs);
    if (!overrideText) setInput("");
    setLoading(true); setStreamingContent("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const conv = updatedConvs.find((c) => c.id === convId);
    const history = conv.messages.slice(0, -1);
    callGroqStream(
      apiKey, history, text,
      (partial) => setStreamingContent(partial),
      (full) => {
        const assistantMsg = { role: "assistant", content: full, id: uid() };
        setConversations((prev) =>
          prev.map((c) => c.id === convId ? { ...c, messages: [...c.messages, assistantMsg] } : c)
        );
        setStreamingContent(""); setLoading(false); playNotifSound();
      },
      (errMsg) => { setError(errMsg); setStreamingContent(""); setLoading(false); }
    );
  }

  async function regenerateLastResponse() {
    if (loading || !activeConv) return;
    const msgs = activeConv.messages;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const lastUserText = msgs[lastUserIdx].content;
    const trimmedMsgs = msgs.slice(0, lastUserIdx);
    setConversations((prev) =>
      prev.map((c) => c.id === activeId ? { ...c, messages: trimmedMsgs } : c)
    );
    setError(null); setLoading(true); setStreamingContent("");
    callGroqStream(
      apiKey, trimmedMsgs, lastUserText,
      (partial) => setStreamingContent(partial),
      (full) => {
        const userMsg = { role: "user", content: lastUserText, id: uid() };
        const assistantMsg = { role: "assistant", content: full, id: uid() };
        setConversations((prev) =>
          prev.map((c) => c.id === activeId ? { ...c, messages: [...trimmedMsgs, userMsg, assistantMsg] } : c)
        );
        setStreamingContent(""); setLoading(false); playNotifSound();
      },
      (errMsg) => { setError(errMsg); setStreamingContent(""); setLoading(false); }
    );
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }
  function handleTextareaChange(e) {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  }

  // ── Theme tokens ─────────────────────────────────────────────────────────
  const T = {
    sidebarBg: dark ? "rgba(12,6,2,.8)" : "rgba(255,248,238,.9)",
    sidebarBorder: dark ? "1px solid rgba(255,140,0,.08)" : "1px solid rgba(255,140,0,.15)",
    headerBg: dark ? "rgba(12,6,2,.5)" : "rgba(255,248,238,.7)",
    headerBorder: dark ? "1px solid rgba(255,140,0,.07)" : "1px solid rgba(255,140,0,.12)",
    inputBoxBg: dark ? "rgba(22,12,4,.9)" : "rgba(255,255,255,.95)",
    inputBoxBorder: dark ? "1px solid rgba(255,140,0,.12)" : "1px solid rgba(255,140,0,.2)",
    textareaColor: dark ? "#f0e8d8" : "#1a1208",
    historyItemActive: dark ? "rgba(255,140,0,.1)" : "rgba(255,140,0,.12)",
    historyTitleColor: dark ? "#c4a870" : "#6b4226",
    menuBtnBg: dark ? "rgba(255,140,0,.05)" : "rgba(255,140,0,.07)",
    menuBtnBorder: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.15)",
    menuBtnColor: dark ? "#c4a060" : "#a05020",
    emptySubtitle: dark ? "#7a5a30" : "#a07040",
    chipBg: dark ? "rgba(255,140,0,.05)" : "rgba(255,255,255,.8)",
    chipBorder: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.2)",
    chipColor: dark ? "#c4a060" : "#8b4513",
    disclaimerColor: dark ? "#4a3020" : "#b08060",
    deleteBtnColor: dark ? "#5a4030" : "#b09070",
    inputAreaBg: dark
      ? "linear-gradient(180deg,transparent,rgba(10,5,1,.9) 30%)"
      : "linear-gradient(180deg,transparent,rgba(250,246,240,.97) 30%)",
    errorBg: dark ? "rgba(255,80,30,.06)" : "rgba(200,60,0,.04)",
    errorBorder: dark ? "1px solid rgba(255,100,30,.22)" : "1px solid rgba(200,80,0,.18)",
    searchBg: dark ? "rgba(255,140,0,.04)" : "rgba(255,140,0,.05)",
    searchBorder: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.15)",
    searchColor: dark ? "#d4b880" : "#6b3a1a",
    footerBorder: dark ? "1px solid rgba(255,140,0,.08)" : "1px solid rgba(255,140,0,.12)",
  };

  const lastAssistantIdx = messages.reduce((acc, m, i) => m.role === "assistant" ? i : acc, -1);
  const canSend = input.trim() && !loading;

  return (
    <div style={{ display: "flex", height: "100vh", background: "transparent", color: dark ? "#f0e8d8" : "#1a1208", overflow: "hidden", transition: "color .35s" }}>

      {/* ── Sidebar ── */}
      <div style={{
        background: T.sidebarBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderRight: T.sidebarBorder, flexShrink: 0,
        width: sidebarOpen ? 268 : 0, overflow: "hidden", transition: "width .28s cubic-bezier(.4,0,.2,1),background .35s",
      }}>
        <div style={{ width: 268, height: "100%", display: "flex", flexDirection: "column", padding: "18px 12px" }}>

          {/* Logo */}
          <div style={{ padding: "4px 8px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <TchatooLogo size={28} />
            <span style={{
              fontSize: 16, fontWeight: 700,
              background: "linear-gradient(135deg,#FFA500 0%,#FF4500 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", letterSpacing: ".3px",
            }}>Tchatoo</span>
          </div>

          {/* New chat */}
          <button onClick={newConversation} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: "linear-gradient(135deg,rgba(255,140,0,.12),rgba(255,69,0,.07))",
            border: "1px solid rgba(255,140,0,.25)", borderRadius: 12,
            color: dark ? "#f0d090" : "#8b3a00",
            padding: "10px 14px", cursor: "pointer", fontSize: 13.5, fontWeight: 500, marginBottom: 12,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
            </svg>
            Nouvelle discussion
          </button>

          {/* Search */}
          <div style={{ position: "relative", marginBottom: 12 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <circle cx="11" cy="11" r="8" stroke={dark ? "#7a5a30" : "#b07040"} strokeWidth="2"/>
              <path d="M21 21L16.65 16.65" stroke={dark ? "#7a5a30" : "#b07040"} strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <input type="text" placeholder="Rechercher…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%", background: T.searchBg, border: T.searchBorder,
                borderRadius: 9, color: T.searchColor, padding: "8px 10px 8px 30px",
                fontSize: 12.5, outline: "none", fontFamily: "'Inter',sans-serif",
              }}
            />
          </div>

          {/* Conv list */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, paddingRight: 2 }}>
            {filteredConvs.length === 0 && (
              <p style={{ fontSize: 12.5, color: dark ? "#5a3a18" : "#c09060", textAlign: "center", marginTop: 24, fontStyle: "italic" }}>
                {search ? "Aucun résultat" : "Aucune conversation"}
              </p>
            )}
            {filteredConvs.map((conv) => {
              const isActive = conv.id === activeId;
              return (
                <div key={conv.id}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "9px 10px", borderRadius: 10, cursor: "pointer",
                    background: isActive
                      ? T.historyItemActive
                      : "transparent",
                    borderLeft: isActive ? "2px solid #FFA500" : "2px solid transparent",
                    transition: "all .15s",
                  }}
                  onClick={() => { setActiveId(conv.id); setError(null); }}
                >
                  <span style={{ fontSize: 12.5, color: T.historyTitleColor, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {getTitle(conv.messages)}
                  </span>
                  <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    <button onClick={(e) => { e.stopPropagation(); exportConversation(conv); }} title="Exporter"
                      style={{ background: "none", border: "none", color: T.deleteBtnColor, cursor: "pointer", padding: "3px 5px", borderRadius: 5, transition: "all .2s", display: "flex" }}
                      onMouseEnter={(e) => e.currentTarget.style.color = "#FFA500"}
                      onMouseLeave={(e) => e.currentTarget.style.color = T.deleteBtnColor}
                    ><ExportIcon /></button>
                    <button onClick={(e) => deleteConversation(conv.id, e)} title="Supprimer"
                      style={{ background: "none", border: "none", color: T.deleteBtnColor, cursor: "pointer", padding: "3px 5px", borderRadius: 5, transition: "all .2s", display: "flex" }}
                      onMouseEnter={(e) => e.currentTarget.style.color = "#ff6b4a"}
                      onMouseLeave={(e) => e.currentTarget.style.color = T.deleteBtnColor}
                    ><TrashIcon /></button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer: dark/light toggle */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: T.footerBorder }}>
            <button onClick={() => setDark((v) => !v)} style={{
              background: dark ? "rgba(255,140,0,.05)" : "rgba(255,140,0,.07)",
              border: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.15)",
              color: dark ? "#c4a060" : "#8b4513",
              cursor: "pointer", fontSize: 12.5, padding: "9px 12px", borderRadius: 8,
              width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 9,
              fontFamily: "'Inter',sans-serif",
            }}>
              {dark ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="5" stroke="#FFA500" strokeWidth="2"/>
                  <line x1="12" y1="2" x2="12" y2="5" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="19" x2="12" y2="22" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="2" y1="12" x2="5" y2="12" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="19" y1="12" x2="22" y2="12" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="17.66" y1="6.34" x2="19.78" y2="4.22" stroke="#FFA500" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="#8b4513" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
              {dark ? "Mode clair" : "Mode sombre"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "12px 20px",
          borderBottom: T.headerBorder, background: T.headerBg,
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", flexShrink: 0,
          transition: "background .35s",
        }}>
          <button onClick={() => setSidebarOpen((v) => !v)} style={{
            background: T.menuBtnBg, border: T.menuBtnBorder, color: T.menuBtnColor,
            cursor: "pointer", padding: "7px 9px", borderRadius: 8, display: "flex", alignItems: "center",
          }}>
            <MenuIcon color={T.menuBtnColor} />
          </button>

          {/* Model badge */}
          <span style={{
            fontSize: 11.5, color: "#FFA500",
            background: "linear-gradient(135deg,rgba(255,140,0,.1),rgba(255,69,0,.05))",
            border: "1px solid rgba(255,140,0,.2)", borderRadius: 999,
            padding: "4px 12px", fontWeight: 500, fontFamily: "'JetBrains Mono',monospace", letterSpacing: ".02em",
          }}>Tchatoo</span>

          {/* Export current conv */}
          {activeConv && activeConv.messages.length > 0 && (
            <button onClick={() => exportConversation(activeConv)} title="Exporter cette conversation"
              style={{
                marginLeft: "auto", background: "none",
                border: dark ? "1px solid rgba(255,140,0,.1)" : "1px solid rgba(255,140,0,.18)",
                borderRadius: 8, color: dark ? "#7a5a30" : "#a06030",
                cursor: "pointer", fontSize: 12, padding: "5px 12px",
                display: "flex", alignItems: "center", gap: 6, transition: "all .2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#FFA500"; e.currentTarget.style.borderColor = "rgba(255,140,0,.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = dark ? "#7a5a30" : "#a06030"; e.currentTarget.style.borderColor = dark ? "rgba(255,140,0,.1)" : "rgba(255,140,0,.18)"; }}
            >
              <ExportIcon color="currentColor" /> Exporter
            </button>
          )}
        </div>

        {/* Messages */}
        <div style={{
          flex: 1, overflowY: "auto", padding: "28px 24px",
          display: "flex", flexDirection: "column", gap: 18,
          maxWidth: 820, width: "100%", margin: "0 auto", alignSelf: "stretch",
        }}>
          {messages.length === 0 && !loading && (
            <div style={{ textAlign: "center", margin: "auto", paddingTop: 40 }}>
              {/* Big logo */}
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 20,
                  // background: "linear-gradient(135deg,white,white)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  boxShadow: "0 8px 32px -8px rgba(235, 167, 79, 0.94)",
                }}>
                  <TchatooLogo size={52} />
                </div>
              </div>
              <h2 style={{
                fontSize: 30, fontWeight: 700, marginBottom: 8,
                background: "linear-gradient(135deg,#FFA500 0%,#FF4500 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
              }}>Quel est le programme aujourd’hui ?</h2>

             
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", maxWidth: 600, marginTop: "20px" }}>
                {[
                  "Résume les avantages de React",
                  "Explique-moi le machine learning",
                  "Rédige un email professionnel",
                  "Écris du code Python pour lister ub tableau de données",
                  "Exemple de recette de pancakes",
              
                ].map((s) => (
                  <button key={s}
                    style={{
                      background: T.chipBg, border: T.chipBorder, borderRadius: 999,
                      color: T.chipColor, padding: "9px 18px", fontSize: 13, cursor: "pointer",
                      transition: "all .25s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(255,140,0,.4)"; e.currentTarget.style.color = "#FFA500"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = dark ? "rgba(255,140,0,.1)" : "rgba(255,140,0,.2)"; e.currentTarget.style.color = T.chipColor; }}
                    onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                  >{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <Message key={msg.id} msg={msg} dark={dark}
              isLast={idx === lastAssistantIdx}
              isAssistant={msg.role === "assistant"}
              onRegenerate={!loading ? regenerateLastResponse : null}
            />
          ))}

          {/* Streaming bubble */}
          {loading && streamingContent && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, animation: "fadeIn .3s ease" }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10, flexShrink: 0, overflow: "hidden",
                background: dark ? "linear-gradient(135deg,#2a1a0a,#1a0f05)" : "linear-gradient(135deg,#fff3e0,#ffe0b2)",
                border: dark ? "1px solid rgba(255,140,0,.15)" : "1px solid rgba(255,140,0,.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><TchatooLogo size={20} /></div>
              <div style={{
                padding: "13px 17px", fontSize: 14, lineHeight: 1.7, maxWidth: "72%",
                background: dark ? "#18100a" : "#fff",
                color: dark ? "#f0e8d8" : "#1a1a2e",
                border: dark ? "1px solid rgba(255,140,0,.08)" : "1px solid rgba(255,140,0,.15)",
                borderRadius: "4px 18px 18px 18px",
              }}>
                <div className="streaming-cursor" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }} />
              </div>
            </div>
          )}

          {loading && !streamingContent && <TypingIndicator dark={dark} />}

          {error && (
            <div style={{
              background: T.errorBg, border: T.errorBorder, borderRadius: 12,
              padding: "13px 18px", color: "#ff9b6a", fontSize: 13.5,
            }}>
              <strong>Erreur :</strong> {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div style={{
          padding: "12px 22px 18px", background: T.inputAreaBg,
          flexShrink: 0, maxWidth: 820, width: "100%", margin: "0 auto", alignSelf: "stretch",
          transition: "background .35s",
        }}>
          <div style={{
            display: "flex", alignItems: "flex-end",
            background: T.inputBoxBg, border: T.inputBoxBorder, borderRadius: 16,
            padding: "10px 10px 10px 18px", gap: 10,
            backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
            boxShadow: dark
              ? "0 8px 32px -12px rgba(255,100,0,.15),inset 0 1px 0 rgba(255,255,255,.03)"
              : "0 8px 32px -12px rgba(255,100,0,.1),inset 0 1px 0 rgba(255,255,255,.9)",
            transition: "box-shadow .25s, border .25s",
          }}>
            <textarea ref={textareaRef}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: T.textareaColor, fontSize: 14.5, lineHeight: 1.6,
                resize: "none", maxHeight: 160, overflowY: "auto", padding: "6px 0",
                transition: "color .35s",
              }}
              placeholder="Envoyez un message…"
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            {/* Send button with SVG icon */}
            <button
              onClick={() => sendMessage()}
              disabled={!canSend}
              title="Envoyer"
              style={{
                background: canSend
                  ? "linear-gradient(135deg,#FF8C00 0%,#FF4500 100%)"
                  : dark ? "rgba(255,140,0,.1)" : "rgba(255,140,0,.12)",
                border: canSend ? "none" : dark ? "1px solid rgba(255,140,0,.15)" : "1px solid rgba(255,140,0,.2)",
                borderRadius: 11, color: "#fff",
                width: 40, height: 40, flexShrink: 0,
                boxShadow: canSend ? "0 4px 16px -4px rgba(255,100,0,.55)" : "none",
                transition: "all .25s cubic-bezier(.4,0,.2,1)",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: canSend ? "pointer" : "not-allowed",
                animation: canSend ? "pulse 2.5s infinite" : "none",
              }}
            >
              {loading ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1s linear infinite" }}>
                  <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.3)" strokeWidth="2.5"/>
                  <path d="M12 3C7.03 3 3 7.03 3 12" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
                </svg>
              ) : (
                <SendIcon />
              )}
            </button>
          </div>
          <p style={{ fontSize: 11, color: T.disclaimerColor, textAlign: "center", marginTop: 9, letterSpacing: ".02em" }}>
            Tchatoo votre assistant intelligent
          </p>
        </div>
      </div>
    </div>
  );
}