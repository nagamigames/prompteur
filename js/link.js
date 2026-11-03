// Liaison temps réel entre l'écran (iPhone) et la régie (iPad).
// Deux modes, même interface :
//  - « local » : la page vient du serveur du Mac → WebSocket relayé par le Mac ;
//  - « en ligne » : la page vient d'un hébergement statique → WebRTC direct (PeerJS).
//
// createLink({ role, code, onMessage, onState, onPeerJoined })
//   → { send(msg), mode, reconnectNow(), close() }
// États : 'connecting' (pas de serveur) · 'waiting' (en attente de l'autre appareil) · 'connected'

const PING_EVERY = 2000;
const DEAD_AFTER = 6000;

export async function detectMode() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('api/info', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const info = await res.json();
      if (info && info.mode === 'local') return { mode: 'local', info };
    }
  } catch {}
  return { mode: 'online', info: null };
}

export async function createLink(opts) {
  const { mode } = await detectMode();
  return mode === 'local' ? wsLink(opts) : peerLink(opts);
}

function wsLink({ role, onMessage, onState, onPeerJoined }) {
  const other = role === 'display' ? 'remote' : 'display';
  let ws = null;
  let gen = 0;
  let lastRx = 0;
  let retry = 0;
  let retryTimer = null;
  let peers = 0;
  let state = '';
  let closed = false;

  const setState = (s) => {
    if (s !== state) {
      state = s;
      onState?.(s);
    }
  };

  function connect() {
    clearTimeout(retryTimer);
    if (closed) return;
    const myGen = ++gen;
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', 'local'); // un seul couple d'appareils par Mac
    url.searchParams.set('role', role);
    setState('connecting');
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      return scheduleRetry();
    }
    ws = sock;
    sock.onopen = () => {
      if (myGen !== gen) return;
      retry = 0;
      lastRx = Date.now();
      setState(peers > 0 ? 'connected' : 'waiting');
    };
    sock.onmessage = (ev) => {
      if (myGen !== gen) return;
      lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'pong') return;
      if (msg.t === 'presence') {
        const n = msg.roles?.[other] || 0;
        const joined = n > peers || (n > 0 && msg.joined === other);
        peers = n;
        setState(n > 0 ? 'connected' : 'waiting');
        if (joined && n > 0) onPeerJoined?.();
        return;
      }
      onMessage?.(msg);
    };
    sock.onclose = (ev) => {
      if (myGen !== gen) return;
      if (ev.code === 4001) return replaced();
      drop();
    };
    sock.onerror = () => {};
  }

  function drop() {
    gen++;
    try { ws?.close(); } catch {}
    ws = null;
    peers = 0;
    setState('connecting');
    scheduleRetry();
  }

  // Un autre appareil a pris ce rôle : on se retire sans relancer,
  // et on ne reprend la main que si cette page revient au premier plan.
  function replaced() {
    gen++;
    clearTimeout(retryTimer);
    ws = null;
    peers = 0;
    setState('replaced');
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (closed) return;
    const delay = [300, 1000, 2000, 3000][Math.min(retry++, 3)];
    retryTimer = setTimeout(connect, delay);
  }

  const timer = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastRx > DEAD_AFTER) return drop();
    try { ws.send('{"t":"ping"}'); } catch {}
  }, PING_EVERY);

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (!ws || ws.readyState > 1) { retry = 0; connect(); }
    else if (ws.readyState === 1) { try { ws.send('{"t":"ping"}'); } catch {} }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  connect();

  return {
    mode: 'local',
    send(msg) {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(msg)); return true; } catch {}
      }
      return false;
    },
    reconnectNow() { retry = 0; drop(); },
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      gen++;
      try { ws?.close(); } catch {}
    },
  };
}

// ---- Mode en ligne : WebRTC via PeerJS ----
// L'écran s'enregistre sous l'identifiant « ipadprompter-<code> », la régie s'y connecte.
// Les données passent directement d'un appareil à l'autre ; le serveur PeerJS ne sert qu'à se trouver.

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/peerjs.min.js', location.href).href;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('peerjs'));
    document.head.appendChild(s);
  });
}

const peerId = (code) => 'ipadprompter-v1-' + code;

function peerLink({ role, code, onMessage, onState, onPeerJoined }) {
  let state = '';
  let closed = false;
  let peer = null;
  let peerGen = 0;
  const conns = new Map(); // conn → dernier message reçu
  let retryTimer = null;

  const setState = (s) => {
    if (s !== state) {
      state = s;
      onState?.(s);
    }
  };
  const refreshState = () => {
    if (!peer || peer.destroyed || peer.disconnected) {
      if (!conns.size) return setState('connecting');
    }
    setState(conns.size ? 'connected' : 'waiting');
  };

  function retryLater(fn, ms) {
    clearTimeout(retryTimer);
    if (!closed) retryTimer = setTimeout(fn, ms);
  }

  function attach(conn) {
    conn.on('open', () => {
      conns.set(conn, Date.now());
      refreshState();
      onPeerJoined?.();
    });
    conn.on('data', (msg) => {
      conns.set(conn, Date.now());
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'ping') { try { conn.send({ t: 'pong' }); } catch {} return; }
      if (msg.t === 'pong') return;
      onMessage?.(msg);
    });
    const gone = () => {
      if (!conns.has(conn)) return;
      conns.delete(conn);
      refreshState();
      if (role === 'remote' && !conns.size) retryLater(connectToDisplay, 500);
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  function connectToDisplay() {
    if (closed || !peer || peer.destroyed || peer.disconnected || !peer.open) return;
    if (conns.size) return;
    const conn = peer.connect(peerId(code), { reliable: true, serialization: 'json' });
    attach(conn);
    // Si rien ne s'ouvre, on réessaie.
    setTimeout(() => {
      if (!conns.has(conn)) {
        try { conn.close(); } catch {}
        retryLater(connectToDisplay, 1500);
      }
    }, 5000);
  }

  async function start() {
    clearTimeout(retryTimer);
    if (closed) return;
    setState('connecting');
    try {
      await loadPeerJs();
    } catch {
      return retryLater(start, 3000);
    }
    const myGen = ++peerGen;
    try { peer?.destroy(); } catch {}
    peer = role === 'display'
      ? new window.Peer(peerId(code), { debug: 0 })
      : new window.Peer({ debug: 0 });
    const p = peer;
    p.on('open', () => {
      if (myGen !== peerGen) return;
      refreshState();
      if (role === 'remote') connectToDisplay();
    });
    if (role === 'display') p.on('connection', attach);
    p.on('disconnected', () => {
      if (myGen !== peerGen || closed) return;
      refreshState();
      retryLater(() => { if (myGen === peerGen && !p.destroyed) p.reconnect(); }, 1000);
    });
    p.on('error', (err) => {
      if (myGen !== peerGen || closed) return;
      const type = err?.type;
      if (type === 'peer-unavailable') {
        // L'écran n'est pas (encore) en ligne.
        refreshState();
        return retryLater(connectToDisplay, 2000);
      }
      // 'unavailable-id' : l'ancien identifiant n'est pas encore libéré (rechargement de l'écran).
      refreshState();
      retryLater(start, type === 'unavailable-id' ? 3000 : 2000);
    });
  }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [conn, last] of conns) {
      if (now - last > DEAD_AFTER) {
        conns.delete(conn);
        try { conn.close(); } catch {}
        refreshState();
        if (role === 'remote') retryLater(connectToDisplay, 300);
        continue;
      }
      if (role === 'remote') { try { conn.send({ t: 'ping' }); } catch {} }
    }
  }, PING_EVERY);

  const onVisible = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (!peer || peer.destroyed) start();
    else if (peer.disconnected) peer.reconnect();
    else if (role === 'remote' && !conns.size) connectToDisplay();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  start();

  return {
    mode: 'online',
    send(msg) {
      let ok = false;
      for (const conn of conns.keys()) {
        if (conn.open) { try { conn.send(msg); ok = true; } catch {} }
      }
      return ok;
    },
    reconnectNow() { for (const c of conns.keys()) { try { c.close(); } catch {} } conns.clear(); start(); },
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      try { peer?.destroy(); } catch {}
    },
  };
}
