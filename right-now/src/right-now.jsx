import { useState, useEffect, useRef, useCallback } from "react";

/* ─────────────────────────── palette ─────────────────────────── */
const C = {
  ground: "#E3E7E8",
  surface: "#F4F6F6",
  ink: "#182028",
  muted: "#6B7780",
  edge: "#C9D0D2",
  live: "#1F6F5C",
};

const SWATCHES = [
  "#1F6F5C", // pine
  "#A8552F", // clay
  "#26557A", // harbor
  "#6B4470", // plum
  "#5E6E33", // moss
  "#8A3A46", // brick
  "#3F4A57", // slate
  "#9A7B25", // ochre
];

const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif";
const SANS =
  "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const STORE_KEY = "rightnow:v1";
const HOUR_PX = 40;

/* Works in three places: the artifact sandbox (window.storage), a plain
   browser tab, and a packaged Tauri app (both use localStorage). */
async function loadState() {
  try {
    if (window.storage?.get) {
      const r = await window.storage.get(STORE_KEY);
      return r ? JSON.parse(r.value) : null;
    }
  } catch { /* no key yet, or no sandbox storage — fall through */ }
  try {
    const raw = window.localStorage?.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const hasTauri = () => Boolean(window.__TAURI__?.core?.invoke);
const tauriInvoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

/* Capture straight to 16 kHz mono PCM — the exact shape whisper wants — so
   nothing has to decode a container format on the Rust side. */
const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('cap', Cap);
`;

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const url = URL.createObjectURL(
    new Blob([WORKLET_SRC], { type: "application/javascript" })
  );
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "cap");
  const mute = ctx.createGain();
  mute.gain.value = 0; // keeps the graph pulling without playing you back
  const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  return {
    async stop() {
      stream.getTracks().forEach((t) => t.stop());
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      mute.disconnect();
      await ctx.close();

      let n = chunks.reduce((a, c) => a + c.length, 0);
      // whisper.cpp needs at least a second; pad short bursts with silence
      const min = 16000 * 1.2;
      const pcm = new Int16Array(Math.max(n, min));
      let o = 0;
      for (const c of chunks) {
        for (let i = 0; i < c.length; i++, o++) {
          const s = Math.max(-1, Math.min(1, c[i]));
          pcm[o] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      }
      const bytes = new Uint8Array(pcm.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    },
  };
}

async function saveState(data) {
  const json = JSON.stringify(data);
  try {
    if (window.storage?.set) {
      await window.storage.set(STORE_KEY, json);
      return;
    }
  } catch { /* fall through to localStorage */ }
  try { window.localStorage?.setItem(STORE_KEY, json); } catch { /* in memory only */ }
}

/* ─────────────────────────── helpers ─────────────────────────── */
const uid = () =>
  (globalThis.crypto?.randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2));

const IRREGULAR = {
  studying: "Studied", working: "Worked", reading: "Read", writing: "Wrote",
  coding: "Coded", running: "Ran", eating: "Ate", sleeping: "Slept",
  cooking: "Cooked", training: "Trained", cleaning: "Cleaned",
  driving: "Drove", practicing: "Practiced", practising: "Practised",
  meeting: "Met", exercising: "Exercised", walking: "Walked",
  thinking: "Thought", drawing: "Drew", building: "Built", making: "Made",
  teaching: "Taught", learning: "Learned", resting: "Rested",
  revising: "Revised", editing: "Edited", designing: "Designed",
};

function pastTense(label) {
  const words = label.trim().split(/\s+/);
  if (!words.length) return label;
  const head = words[0].toLowerCase();
  const rest = words.slice(1).join(" ");
  let done;
  if (IRREGULAR[head]) done = IRREGULAR[head];
  else if (head.endsWith("ing") && head.length > 4) {
    let stem = head.slice(0, -3);
    if (stem.length > 2 && /([bdgklmnprtvz])\1$/.test(stem)) stem = stem.slice(0, -1);
    done = cap(stem.endsWith("e") ? stem + "d" : stem + "ed");
  } else done = cap(head);
  return rest ? `${done} ${rest}` : done;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h && mm) return `${h}h ${mm}m`;
  if (h) return `${h}h`;
  return `${mm}m`;
}

function fmtClock(d) {
  return new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}

function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
}

/* split a session across midnight boundaries */
function splitByDay(start, end) {
  const out = [];
  let cur = new Date(start);
  while (cur.getTime() < end) {
    const midnight = new Date(cur);
    midnight.setHours(24, 0, 0, 0);
    const segEnd = Math.min(midnight.getTime(), end);
    out.push({ key: dayKey(cur), start: cur.getTime(), end: segEnd });
    cur = new Date(segEnd);
  }
  return out;
}

/* ─────────────────────── phrase interpretation ─────────────────────── */
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const WEEKDAYS = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6, sunday: 0,
};

function parseTime(text) {
  let m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (/p/i.test(m[3])) h += 12;
    return { h, m: m[2] ? parseInt(m[2], 10) : 0, raw: m[0] };
  }
  m = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10), raw: m[0] };
  if (/\bnoon\b/i.test(text)) return { h: 12, m: 0, raw: "noon" };
  return null;
}

function parseDate(text) {
  const now = new Date();
  const t = text.toLowerCase();

  let m = t.match(
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(st|nd|rd|th)?\b/
  );
  if (m) {
    const month = MONTHS[m[1]];
    const day = parseInt(m[2], 10);
    let year = now.getFullYear();
    const cand = new Date(year, month, day);
    if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
    return { date: new Date(year, month, day), raw: m[0] };
  }

  m = t.match(/\b(\d{1,2})(st|nd|rd|th)?\s+of\s+([a-z]+)\b/);
  if (m && MONTHS[m[3]] !== undefined) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[3]];
    let year = now.getFullYear();
    const cand = new Date(year, month, day);
    if (cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
    return { date: new Date(year, month, day), raw: m[0] };
  }

  if (/\btomorrow\b/.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
    return { date: d, raw: "tomorrow" };
  }
  if (/\btoday\b/.test(t) || /\btonight\b/.test(t)) {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    return { date: d, raw: /\btonight\b/.test(t) ? "tonight" : "today" };
  }

  m = t.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (m) {
    const target = WEEKDAYS[m[2]];
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1]) delta += delta <= 6 && m[1] ? 0 : 0;
    d.setDate(d.getDate() + delta);
    return { date: d, raw: m[0] };
  }
  return null;
}

function interpret(text) {
  const raw = text.trim();
  const t = raw.toLowerCase();
  if (!raw) return null;

  if (/^(stop|done|finished|finish|i'?m done|that'?s it|end|over)\b/.test(t))
    return { type: "stop" };

  const taskM = t.match(
    /^(i need to|i needa|i have to|i've got to|i gotta|i must|i should|todo:?|to-?do:?|remind me to|don'?t forget to)\s+(.+)$/
  );
  if (taskM) {
    let rest = raw.slice(raw.length - taskM[2].length);
    const dd = parseDate(rest);
    let due = null;
    if (dd) {
      due = dd.date.getTime();
      rest = rest
        .replace(new RegExp(escapeRe(dd.raw), "i"), " ")
        .replace(/\s+(by|on|before|due|until)\s*$/i, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return { type: "task", text: cap(rest), due };
  }

  const d = parseDate(raw);
  if (d) {
    const time = parseTime(raw);
    let title = raw;
    // strip the scheduling scaffolding, keep the subject
    title = title
      .replace(new RegExp(escapeRe(d.raw), "i"), " ")
      .replace(time ? new RegExp(escapeRe(time.raw), "i") : /$^/, " ")
      .replace(/^\s*(i\s+have|i'?ve\s+got|there'?s|remind me( about)?|add|schedule|put)\s+/i, " ")
      .replace(/\b(an?|the)\b/gi, " ")
      .replace(/\b(on|at|in|of|for|to|from)\b\s*$/gi, " ")
      .replace(/\s+(on|at|in|of)\s*$/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/^(on|at|in|of|for)\s+/i, "")
      .replace(/\s+(on|at|in|of|for)$/i, "");
    const when = new Date(d.date);
    if (time) when.setHours(time.h, time.m, 0, 0);
    return {
      type: "event",
      title: cap(title || "Event"),
      when,
      allDay: !time,
    };
  }

  const label = raw
    .replace(/^\s*(i'?m|i am|im|i'?ll be|start|starting|currently|now)\s+/i, "")
    .replace(/^\s*(doing|on)\s+/i, "")
    .trim();
  return { type: "start", label: cap(label || raw) };
}

/* ───────────────────────────── ICS ───────────────────────────── */
function icsStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "T" +
    p(d.getHours()) + p(d.getMinutes()) + "00"
  );
}

function downloadICS(ev) {
  const start = new Date(ev.when);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Right Now//EN",
    "BEGIN:VEVENT", `UID:${ev.id}@rightnow`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
    `SUMMARY:${ev.title.replace(/([,;\\])/g, "\\$1")}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${ev.title.replace(/[^\w]+/g, "-").toLowerCase()}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ═══════════════════════════ component ═══════════════════════════ */
export default function RightNow() {
  const [sessions, setSessions] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [events, setEvents] = useState([]);
  const [colors, setColors] = useState({});
  const [active, setActive] = useState(null); // {label, start}
  const [loaded, setLoaded] = useState(false);

  const [view, setView] = useState("now");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(null); // event awaiting confirmation
  const [reveal, setReveal] = useState(null); // just-finished session
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [micNote, setMicNote] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);

  const inputRef = useRef(null);
  const recRef = useRef(null);
  const recorderRef = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = active;

  /* ── load ── */
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadState();
      if (alive && d) {
        setSessions(d.sessions || []);
        setTasks(d.tasks || []);
        setEvents(d.events || []);
        setColors(d.colors || {});
        setActive(d.active || null);
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  /* ── save ── */
  useEffect(() => {
    if (!loaded) return;
    saveState({ sessions, tasks, events, colors, active });
  }, [sessions, tasks, events, colors, active, loaded]);

  /* ── color assignment ── */
  const colorFor = useCallback(
    (label) => {
      const k = label.toLowerCase();
      if (colors[k]) return colors[k];
      let hash = 0;
      for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) >>> 0;
      return SWATCHES[hash % SWATCHES.length];
    },
    [colors]
  );

  /* ── actions ── */
  const begin = useCallback((label, taskId = null) => {
    setReveal(null);
    setActive({ label, start: Date.now(), taskId });
    setDraft("");
  }, []);

  const finish = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    const s = {
      id: uid(),
      label: a.label,
      past: pastTense(a.label),
      start: a.start,
      end: Date.now(),
      taskId: a.taskId || null,
    };
    setSessions((p) => [...p, s]);
    setActive(null);
    setReveal(s);
  }, []);

  const addTask = useCallback((text, due = null) => {
    if (!text.trim()) return;
    setTasks((p) => [
      ...p,
      { id: uid(), text: text.trim(), due, created: Date.now(), done: false, doneAt: null },
    ]);
  }, []);

  const toggleTask = useCallback((id) => {
    setTasks((p) =>
      p.map((t) =>
        t.id === id ? { ...t, done: !t.done, doneAt: t.done ? null : Date.now() } : t
      )
    );
  }, []);

  const removeTask = useCallback((id) => {
    setTasks((p) => p.filter((t) => t.id !== id));
  }, []);

  const submit = useCallback(
    (text) => {
      const r = interpret(text);
      if (!r) return;
      if (r.type === "stop") { finish(); setDraft(""); return; }
      if (r.type === "task") { addTask(r.text, r.due); setDraft(""); return; }
      if (r.type === "event") { setPending({ ...r, id: uid() }); setDraft(""); return; }
      begin(r.label);
    },
    [begin, finish, addTask]
  );

  /* ── voice ── */

  /* Packaged app: record raw audio, hand it to whisper.cpp in Rust. The model
     is fetched once on first use and lives in the app's data folder. */
  const whisperVoice = useCallback(async () => {
    if (recorderRef.current) {
      const rec = recorderRef.current;
      recorderRef.current = null;
      setListening(false);
      setThinking(true);
      try {
        const audio = await rec.stop();
        const text = await tauriInvoke("transcribe", { audio });
        setThinking(false);
        const clean = (text || "").trim();
        if (clean) { setDraft(clean); submit(clean); }
        else setMicNote("Nothing came through. Try again a bit closer.");
      } catch (err) {
        setThinking(false);
        setMicNote(String(err));
      }
      return;
    }

    try {
      const ready = await tauriInvoke("model_ready");
      if (!ready) {
        setMicNote("Fetching the voice model — about 150 MB, once only.");
        await tauriInvoke("download_model");
      }
      setMicNote("");
      recorderRef.current = await startRecording();
      setListening(true);
    } catch (err) {
      setMicNote(
        String(err).includes("Permission") || String(err).includes("NotAllowed")
          ? "The microphone is blocked. Allow it in your system settings."
          : String(err)
      );
    }
  }, [submit, setDraft]);

  /* Browser: the built-in speech API, which the packaged app doesn't get. */
  const browserVoice = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMicNote("This browser has no speech recognition. Type it instead.");
      return;
    }
    if (listening) { recRef.current?.stop(); return; }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const txt = Array.from(e.results).map((r) => r[0].transcript).join("");
      setDraft(txt);
      if (e.results[e.results.length - 1].isFinal) submit(txt);
    };
    rec.onerror = (e) => {
      setListening(false);
      setMicNote(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "The mic is blocked here. Type what you're doing instead."
          : "Didn't catch that. Try again, or type it."
      );
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setMicNote("");
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }, [listening, submit]);

  const toggleVoice = useCallback(() => {
    if (thinking) return;
    if (hasTauri()) whisperVoice();
    else browserVoice();
  }, [thinking, whisperVoice, browserVoice]);

  /* download progress, when the model is being fetched */
  useEffect(() => {
    let un;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    ev.listen("model-progress", (e) => {
      const pct = Math.round(e.payload || 0);
      setMicNote(
        pct >= 100
          ? "Voice model ready. Press the mic again."
          : `Fetching the voice model — ${pct}%.`
      );
    }).then((f) => { un = f; });
    return () => { if (un) un(); };
  }, []);

  /* ── shortcut ── */
  useEffect(() => {
    const onKey = (e) => {
      const combo = (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Space";
      if (!combo) return;
      e.preventDefault();
      if (activeRef.current) finish();
      else { setView("now"); setTimeout(() => inputRef.current?.focus(), 0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  /* ── OS-level hotkey, when packaged with Tauri ── */
  useEffect(() => {
    let un;
    const ev = window.__TAURI__?.event;
    if (!ev?.listen) return;
    ev.listen("toggle-timer", () => {
      if (activeRef.current) finish();
      else { setView("now"); setTimeout(() => inputRef.current?.focus(), 0); }
    }).then((f) => { un = f; });
    return () => { if (un) un(); };
  }, [finish]);

  /* ── derived: this week ── */
  const weekStart = new Date(startOfWeek());
  weekStart.setDate(weekStart.getDate() + weekOffset * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const inWeek = sessions.filter((s) => s.end > weekStart && s.start < weekEnd);
  const totals = {};
  for (const s of inWeek) {
    const k = s.past;
    const clipped =
      Math.min(s.end, weekEnd.getTime()) - Math.max(s.start, weekStart.getTime());
    totals[k] = (totals[k] || 0) + Math.max(0, clipped);
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const weekTotal = ranked.reduce((n, [, v]) => n + v, 0);

  const revealWeekTotal = reveal
    ? sessions
        .filter((s) => s.past === reveal.past && s.end > startOfWeek().getTime())
        .reduce((n, s) => n + (s.end - s.start), 0)
    : 0;

  /* ─────────────────────────── render ─────────────────────────── */
  return (
    <div style={{
      minHeight: "100vh", background: C.ground, color: C.ink,
      fontFamily: SANS, fontSize: 15, lineHeight: 1.5,
    }}>
      <style>{`
        * { box-sizing: border-box; }
        button { font: inherit; cursor: pointer; }
        input { font: inherit; }
        .rn-focus:focus-visible { outline: 2px solid ${C.ink}; outline-offset: 3px; }
        @keyframes rn-breathe {
          0%,100% { transform: scale(1); opacity: .85; }
          50% { transform: scale(1.55); opacity: .3; }
        }
        @keyframes rn-rise {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: none; }
        }
        .rn-rise { animation: rn-rise .5s cubic-bezier(.2,.7,.3,1) both; }
        .rn-dot { animation: rn-breathe 3.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .rn-dot, .rn-rise { animation: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: 940, margin: "0 auto", padding: "20px 22px 64px" }}>
        {/* header */}
        <header style={{
          display: "flex", alignItems: "baseline", justifyContent: "space-between",
          gap: 16, paddingBottom: 18, marginBottom: 34,
          borderBottom: `1px solid ${C.edge}`,
        }}>
          <div style={{ color: C.muted, fontSize: 13 }}>
            {new Date().toLocaleDateString([], {
              weekday: "long", month: "long", day: "numeric",
            })}
          </div>
          <nav style={{ display: "flex", gap: 4 }}>
            {[["now", "Now"], ["week", "The week"]].map(([k, label]) => (
              <button
                key={k}
                className="rn-focus"
                onClick={() => setView(k)}
                style={{
                  border: "none", background: "none", padding: "4px 2px",
                  marginLeft: 14, fontSize: 13,
                  color: view === k ? C.ink : C.muted,
                  borderBottom: `2px solid ${view === k ? C.ink : "transparent"}`,
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        {view === "now" ? (
          <NowView
            active={active}
            reveal={reveal}
            pending={pending}
            draft={draft}
            setDraft={setDraft}
            submit={submit}
            finish={finish}
            inputRef={inputRef}
            listening={listening}
            thinking={thinking}
            toggleVoice={toggleVoice}
            micNote={micNote}
            colorFor={colorFor}
            ranked={ranked}
            weekTotal={weekTotal}
            revealWeekTotal={revealWeekTotal}
            tasks={tasks}
            addTask={addTask}
            toggleTask={toggleTask}
            removeTask={removeTask}
            startTask={begin}
            dismissReveal={() => setReveal(null)}
            onConfirmEvent={() => {
              setEvents((p) => [...p, pending]);
              setPending(null);
            }}
            onCancelEvent={() => setPending(null)}
          />
        ) : (
          <WeekView
            weekStart={weekStart}
            weekOffset={weekOffset}
            setWeekOffset={setWeekOffset}
            sessions={sessions}
            events={events}
            colorFor={colorFor}
            ranked={ranked}
            weekTotal={weekTotal}
            colors={colors}
            setColors={setColors}
            setSessions={setSessions}
            setEvents={setEvents}
          />
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════ now view ══════════════════════════ */
function NowView({
  active, reveal, pending, draft, setDraft, submit, finish, inputRef,
  listening, thinking, toggleVoice, micNote, colorFor, ranked, weekTotal,
  revealWeekTotal, dismissReveal, onConfirmEvent, onCancelEvent,
  tasks, addTask, toggleTask, removeTask, startTask,
}) {
  const [shown, setShown] = useState(0);

  /* the single earned moment: the number arrives once, then stays */
  useEffect(() => {
    if (!reveal) return;
    const total = reveal.end - reveal.start;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(total);
      return;
    }
    let raf, t0;
    const step = (t) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / 850);
      setShown(total * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reveal]);

  if (pending) {
    return (
      <section className="rn-rise" style={{ paddingTop: 26 }}>
        <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>
          Putting this on the calendar. Is it right?
        </p>
        <h2 style={{ font: `400 34px/1.2 ${SERIF}`, margin: "0 0 8px" }}>
          {pending.title}
        </h2>
        <p style={{ margin: "0 0 26px", fontSize: 16 }}>
          {pending.when.toLocaleDateString([], {
            weekday: "long", month: "long", day: "numeric",
          })}
          {!pending.allDay && ` at ${fmtClock(pending.when)}`}
          {pending.allDay && (
            <span style={{ color: C.muted }}> · no time given</span>
          )}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Primary onClick={onConfirmEvent}>Add it</Primary>
          <Ghost onClick={onCancelEvent}>Never mind</Ghost>
          <Ghost onClick={() => { downloadICS(pending); onConfirmEvent(); }}>
            Add it and send to my calendar app
          </Ghost>
        </div>
      </section>
    );
  }

  if (active) {
    const tint = colorFor(active.label);
    return (
      <section style={{ paddingTop: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
          <span style={{ position: "relative", width: 10, height: 10 }}>
            <span
              className="rn-dot"
              style={{
                position: "absolute", inset: 0, borderRadius: "50%", background: tint,
              }}
            />
          </span>
          <span style={{ color: C.muted, fontSize: 13 }}>Counting quietly</span>
        </div>
        <h1 style={{ font: `400 clamp(38px,7vw,64px)/1.05 ${SERIF}`, margin: "0 0 20px" }}>
          {cap(active.label)}
        </h1>
        <p style={{ color: C.muted, maxWidth: "38ch", margin: "0 0 34px" }}>
          No clock until you're through. Say "stop", or press the button, and
          you'll see what it came to.
        </p>
        <Primary onClick={finish}>I'm done</Primary>
      </section>
    );
  }

  if (reveal) {
    const tint = colorFor(reveal.label);
    const linkedTask = reveal.taskId
      ? tasks.find((t) => t.id === reveal.taskId)
      : null;
    return (
      <section className="rn-rise" style={{ paddingTop: 40 }}>
        <h1 style={{
          font: `400 clamp(32px,6vw,52px)/1.1 ${SERIF}`,
          margin: "0 0 4px", color: tint,
        }}>
          {reveal.past}
        </h1>
        <div style={{
          font: `400 clamp(52px,12vw,104px)/1 ${SERIF}`,
          letterSpacing: "-0.02em", margin: "8px 0 14px",
        }}>
          {fmtDuration(shown)}
        </div>
        <p style={{ color: C.muted, margin: "0 0 4px" }}>
          {fmtClock(reveal.start)} to {fmtClock(reveal.end)}
        </p>
        <p style={{ color: C.muted, margin: "0 0 34px" }}>
          {fmtDuration(revealWeekTotal)} this week.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Primary onClick={dismissReveal}>Back to it</Primary>
          {linkedTask && !linkedTask.done && (
            <Ghost onClick={() => { toggleTask(linkedTask.id); dismissReveal(); }}>
              Cross it off
            </Ghost>
          )}
        </div>
      </section>
    );
  }

  return (
    <section style={{ paddingTop: 34 }}>
      <h1 style={{
        font: `400 clamp(34px,6.4vw,58px)/1.08 ${SERIF}`,
        margin: "0 0 28px", maxWidth: "13ch",
      }}>
        What are you doing right now?
      </h1>

      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        maxWidth: 560, borderBottom: `1px solid ${C.ink}`, paddingBottom: 8,
      }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(draft); }}
          placeholder={
            thinking ? "Working out what you said…" : listening ? "Listening…" : "I'm studying"
          }
          disabled={thinking}
          aria-label="What are you doing right now"
          style={{
            flex: 1, border: "none", background: "none", outline: "none",
            fontSize: 20, color: C.ink, padding: "4px 0",
          }}
        />
        <button
          className="rn-focus"
          onClick={toggleVoice}
          disabled={thinking}
          aria-label={listening ? "Stop listening" : "Say it out loud"}
          title={listening ? "Stop listening" : "Say it out loud"}
          style={{
            border: `1px solid ${listening ? C.live : C.edge}`,
            background: listening ? C.live : "transparent",
            color: listening ? C.surface : C.muted,
            borderRadius: 999, width: 38, height: 38,
            display: "grid", placeItems: "center", flexShrink: 0,
            opacity: thinking ? 0.4 : 1,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
          </svg>
        </button>
      </div>

      <p style={{ color: C.muted, fontSize: 13, marginTop: 12, maxWidth: "52ch" }}>
        {micNote ||
          'Say what you\'re doing, or tell it about something coming up — "I have a dentist appointment on September 22nd at 3pm."'}
      </p>
      <p style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
        ⌘/Ctrl + Shift + Space starts and stops it.
      </p>

      <TodayList
        tasks={tasks}
        addTask={addTask}
        toggleTask={toggleTask}
        removeTask={removeTask}
        startTask={startTask}
      />

      {ranked.length > 0 && (
        <div style={{ marginTop: 52, borderTop: `1px solid ${C.edge}`, paddingTop: 18 }}>
          <div style={{
            display: "flex", justifyContent: "space-between",
            color: C.muted, fontSize: 13, marginBottom: 14,
          }}>
            <span>This week</span>
            <span>{fmtDuration(weekTotal)} accounted for</span>
          </div>
          {ranked.slice(0, 6).map(([label, ms]) => (
            <div key={label} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "7px 0",
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: 2, background: colorFor(label),
                flexShrink: 0,
              }} />
              <span style={{ flex: 1 }}>{label}</span>
              <span style={{
                color: C.muted, fontVariantNumeric: "tabular-nums",
              }}>{fmtDuration(ms)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ══════════════════════════ week view ══════════════════════════ */
function WeekView({
  weekStart, weekOffset, setWeekOffset, sessions, events, colorFor,
  ranked, weekTotal, colors, setColors, setSessions, setEvents,
}) {
  const [editing, setEditing] = useState(null);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const segs = [];
  for (const s of sessions) {
    if (s.end <= weekStart.getTime() || s.start >= weekEnd.getTime()) continue;
    for (const seg of splitByDay(s.start, s.end)) segs.push({ ...seg, s });
  }
  const evs = events
    .map((e) => ({ ...e, when: new Date(e.when) }))
    .filter((e) => e.when >= weekStart && e.when < weekEnd);

  let lo = 8, hi = 20;
  for (const g of segs) {
    lo = Math.min(lo, new Date(g.start).getHours());
    hi = Math.max(hi, new Date(g.end).getHours() + 1);
  }
  for (const e of evs) {
    lo = Math.min(lo, e.when.getHours());
    hi = Math.max(hi, e.when.getHours() + 1);
  }
  lo = Math.max(0, lo);
  hi = Math.min(24, Math.max(hi, lo + 6));
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const top = (ts) => {
    const d = new Date(ts);
    return ((d.getHours() * 60 + d.getMinutes()) / 60 - lo) * HOUR_PX;
  };

  const todayKey = dayKey(new Date());

  return (
    <section>
      <div style={{
        display: "flex", alignItems: "baseline", justifyContent: "space-between",
        gap: 12, marginBottom: 22, flexWrap: "wrap",
      }}>
        <h2 style={{ font: `400 30px/1.2 ${SERIF}`, margin: 0 }}>
          {weekOffset === 0 ? "This week" : weekStart.toLocaleDateString([], {
            month: "long", day: "numeric",
          })}
          <span style={{ color: C.muted, fontSize: 15, fontFamily: SANS, marginLeft: 12 }}>
            {fmtDuration(weekTotal)}
          </span>
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          <Ghost onClick={() => setWeekOffset(weekOffset - 1)}>Earlier</Ghost>
          {weekOffset !== 0 && <Ghost onClick={() => setWeekOffset(0)}>Now</Ghost>}
          <Ghost
            onClick={() => setWeekOffset(weekOffset + 1)}
            disabled={weekOffset >= 0}
          >
            Later
          </Ghost>
        </div>
      </div>

      {segs.length === 0 && evs.length === 0 ? (
        <p style={{ color: C.muted, padding: "40px 0" }}>
          Nothing logged in this week yet. Start something on the Now screen and
          it will show up here.
        </p>
      ) : (
        <div style={{
          background: C.surface, border: `1px solid ${C.edge}`,
          borderRadius: 3, overflow: "hidden",
        }}>
          {/* day names */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.edge}` }}>
            <div style={{ width: 46, flexShrink: 0 }} />
            {days.map((d) => {
              const isToday = dayKey(d) === todayKey;
              return (
                <div key={d.toISOString()} style={{
                  flex: 1, minWidth: 0, padding: "9px 6px", textAlign: "center",
                  fontSize: 12, color: isToday ? C.ink : C.muted,
                  borderLeft: `1px solid ${C.edge}`,
                  fontWeight: isToday ? 600 : 400,
                }}>
                  {d.toLocaleDateString([], { weekday: "short" })} {d.getDate()}
                </div>
              );
            })}
          </div>

          {/* grid */}
          <div style={{ display: "flex", position: "relative" }}>
            <div style={{ width: 46, flexShrink: 0 }}>
              {hours.map((h) => (
                <div key={h} style={{
                  height: HOUR_PX, fontSize: 11, color: C.muted,
                  textAlign: "right", paddingRight: 7, transform: "translateY(-6px)",
                }}>
                  {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
                </div>
              ))}
            </div>
            {days.map((d) => {
              const k = dayKey(d);
              return (
                <div key={k} style={{
                  flex: 1, minWidth: 0, position: "relative",
                  borderLeft: `1px solid ${C.edge}`,
                  height: hours.length * HOUR_PX,
                }}>
                  {hours.map((h, i) => (
                    <div key={h} style={{
                      position: "absolute", left: 0, right: 0, top: i * HOUR_PX,
                      borderTop: i === 0 ? "none" : `1px solid ${C.ground}`,
                      height: HOUR_PX,
                    }} />
                  ))}
                  {segs.filter((g) => g.key === k).map((g) => {
                    const h = Math.max(15, ((g.end - g.start) / 3600000) * HOUR_PX);
                    const tint = colorFor(g.s.label);
                    return (
                      <button
                        key={g.s.id + g.start}
                        className="rn-focus"
                        onClick={() => setEditing(g.s)}
                        title={`${g.s.past} · ${fmtDuration(g.s.end - g.s.start)}`}
                        style={{
                          position: "absolute", left: 2, right: 2, top: top(g.start),
                          height: h - 2, background: tint, color: "#fff",
                          border: "none", borderRadius: 2, textAlign: "left",
                          padding: "3px 5px", overflow: "hidden", fontSize: 11,
                          lineHeight: 1.25, display: "block",
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{g.s.past}</span>
                        {h > 30 && (
                          <span style={{ display: "block", opacity: 0.82 }}>
                            {fmtClock(g.s.start)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {evs.filter((e) => dayKey(e.when) === k).map((e) => (
                    <div key={e.id} style={{
                      position: "absolute", left: 2, right: 2,
                      top: e.allDay ? 0 : top(e.when.getTime()),
                      height: 30, border: `1px dashed ${C.muted}`,
                      borderRadius: 2, padding: "3px 5px", fontSize: 11,
                      color: C.ink, background: C.surface, overflow: "hidden",
                      lineHeight: 1.2,
                    }} title={`${e.title} · upcoming`}>
                      {e.title}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* legend + color editing */}
      {ranked.length > 0 && (
        <div style={{ marginTop: 30 }}>
          <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>
            Pick a color for anything here.
          </p>
          {ranked.map(([label, ms]) => {
            const key = label.toLowerCase();
            const sample = sessions.find((s) => s.past === label);
            const baseKey = sample ? sample.label.toLowerCase() : key;
            const open = editing === label;
            return (
              <div key={label} style={{ padding: "6px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button
                    className="rn-focus"
                    onClick={() => setEditing(open ? null : label)}
                    aria-label={`Change color for ${label}`}
                    style={{
                      width: 15, height: 15, borderRadius: 3, flexShrink: 0,
                      background: colorFor(sample ? sample.label : label),
                      border: `1px solid ${C.edge}`,
                    }}
                  />
                  <span style={{ flex: 1 }}>{label}</span>
                  <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                    {fmtDuration(ms)}
                  </span>
                </div>
                {open && (
                  <div style={{ display: "flex", gap: 7, padding: "10px 0 4px 27px" }}>
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        className="rn-focus"
                        onClick={() => {
                          setColors({ ...colors, [baseKey]: c });
                          setEditing(null);
                        }}
                        aria-label={c}
                        style={{
                          width: 20, height: 20, borderRadius: 3, background: c,
                          border: `1px solid ${C.edge}`,
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {evs.length > 0 && (
        <div style={{ marginTop: 28, borderTop: `1px solid ${C.edge}`, paddingTop: 16 }}>
          <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>Coming up</p>
          {evs.map((e) => (
            <div key={e.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "6px 0",
            }}>
              <span style={{ flex: 1 }}>{e.title}</span>
              <span style={{ color: C.muted, fontSize: 13 }}>
                {e.when.toLocaleDateString([], { month: "short", day: "numeric" })}
                {!e.allDay && ` · ${fmtClock(e.when)}`}
              </span>
              <button
                className="rn-focus"
                onClick={() => setEvents((p) => p.filter((x) => x.id !== e.id))}
                style={{
                  border: "none", background: "none", color: C.muted, fontSize: 13,
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ══════════════════════════ today list ══════════════════════════ */
function TodayList({ tasks, addTask, toggleTask, removeTask, startTask }) {
  const [draft, setDraft] = useState("");

  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const t1 = new Date(t0); t1.setDate(t1.getDate() + 1);

  const open = tasks.filter((t) => !t.done);
  const today = open
    .filter((t) => !t.due || t.due < t1.getTime())
    .sort((a, b) => a.created - b.created);
  const ahead = open
    .filter((t) => t.due && t.due >= t1.getTime())
    .sort((a, b) => a.due - b.due);
  const done = tasks
    .filter((t) => t.done && t.doneAt >= t0.getTime())
    .sort((a, b) => a.doneAt - b.doneAt);

  const total = today.length + done.length;

  const add = () => {
    const raw = draft.trim();
    if (!raw) return;
    const d = parseDate(raw);
    let text = raw, due = null;
    if (d) {
      due = d.date.getTime();
      text = raw
        .replace(new RegExp(escapeRe(d.raw), "i"), " ")
        .replace(/\s+(by|on|before|due|until)\s*$/i, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    addTask(cap(text), due);
    setDraft("");
  };

  return (
    <div style={{ marginTop: 46, borderTop: `1px solid ${C.edge}`, paddingTop: 18 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        color: C.muted, fontSize: 13, marginBottom: 12,
      }}>
        <span>To finish today</span>
        {total > 0 && <span>{done.length} of {total} crossed off</span>}
      </div>

      {total === 0 && ahead.length === 0 && (
        <p style={{ color: C.muted, margin: "0 0 14px", maxWidth: "44ch" }}>
          Nothing on the list yet. Write what today needs below, or say
          "I need to finish the essay" up there.
        </p>
      )}

      {today.map((t) => (
        <TaskRow
          key={t.id} task={t} t0={t0}
          toggleTask={toggleTask} removeTask={removeTask} startTask={startTask}
        />
      ))}

      {done.map((t) => (
        <TaskRow
          key={t.id} task={t} t0={t0}
          toggleTask={toggleTask} removeTask={removeTask} startTask={startTask}
        />
      ))}

      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        marginTop: 10, maxWidth: 520,
      }}>
        <span style={{
          width: 16, height: 16, borderRadius: "50%",
          border: `1px dashed ${C.edge}`, flexShrink: 0,
        }} />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          onBlur={add}
          placeholder="Add something"
          aria-label="Add something to finish today"
          style={{
            flex: 1, border: "none", background: "none", outline: "none",
            borderBottom: `1px solid transparent`, color: C.ink,
            fontSize: 15, padding: "4px 0",
          }}
          onFocus={(e) => (e.target.style.borderBottomColor = C.edge)}
        />
      </div>

      {ahead.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>Later on</div>
          {ahead.map((t) => (
            <TaskRow
              key={t.id} task={t} t0={t0}
              toggleTask={toggleTask} removeTask={removeTask} startTask={startTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, t0, toggleTask, removeTask, startTask }) {
  const [hover, setHover] = useState(false);
  const carriedDays = task.done
    ? 0
    : Math.floor((t0.getTime() - new Date(task.created).setHours(0, 0, 0, 0)) / 86400000);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "6px 0", maxWidth: 520,
      }}
    >
      <button
        className="rn-focus"
        onClick={() => toggleTask(task.id)}
        aria-label={task.done ? `Undo ${task.text}` : `Finish ${task.text}`}
        style={{
          width: 16, height: 16, borderRadius: "50%", flexShrink: 0, padding: 0,
          border: `1px solid ${task.done ? C.live : C.muted}`,
          background: task.done ? C.live : "transparent",
          display: "grid", placeItems: "center",
        }}
      >
        {task.done && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
            stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </button>

      <span style={{
        flex: 1, minWidth: 0,
        color: task.done ? C.muted : C.ink,
        textDecoration: task.done ? "line-through" : "none",
      }}>
        {task.text}
        {!task.done && carriedDays > 0 && (
          <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>
            {carriedDays === 1 ? "since yesterday" : `${carriedDays} days on this`}
          </span>
        )}
        {!task.done && task.due && task.due >= t0.getTime() + 86400000 && (
          <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>
            {new Date(task.due).toLocaleDateString([], { month: "short", day: "numeric" })}
          </span>
        )}
      </span>

      {!task.done && (
        <button
          className="rn-focus"
          onClick={() => startTask(task.text, task.id)}
          style={{
            border: "none", background: "none", color: C.muted,
            fontSize: 13, padding: "2px 4px", flexShrink: 0,
          }}
        >
          Start
        </button>
      )}
      <button
        className="rn-focus"
        onClick={() => removeTask(task.id)}
        aria-label={`Remove ${task.text}`}
        style={{
          border: "none", background: "none", color: C.muted, fontSize: 15,
          lineHeight: 1, padding: "2px 4px", flexShrink: 0,
          opacity: hover ? 1 : 0.25,
        }}
      >
        ×
      </button>
    </div>
  );
}

/* ─────────────────────────── buttons ─────────────────────────── */
function Primary({ children, onClick }) {
  return (
    <button
      className="rn-focus"
      onClick={onClick}
      style={{
        background: C.ink, color: C.surface, border: "none",
        borderRadius: 2, padding: "11px 22px", fontSize: 15,
      }}
    >
      {children}
    </button>
  );
}

function Ghost({ children, onClick, disabled }) {
  return (
    <button
      className="rn-focus"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "none", color: disabled ? C.edge : C.ink,
        border: `1px solid ${disabled ? C.edge : C.muted}`,
        borderRadius: 2, padding: "10px 18px", fontSize: 14,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
