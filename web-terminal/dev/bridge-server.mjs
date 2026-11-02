// Development stand-in for the Android host: real bash sessions over a WebSocket.
// Listens on 127.0.0.1 only — it is a local test harness, never expose it.
//   npm run devbridge   (then `npm run dev` and open the Vite URL)
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 7681);
const sessions = new Map(); // id -> { p, kind, title, alive, buf: Buffer[], size }
const clients = new Set();
const MAX_BUF = 256 * 1024;

const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
};

function create(kind, cols, rows) {
  const id = randomUUID().slice(0, 8);
  const p = pty.spawn(process.env.SHELL || 'bash', ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8' },
    encoding: null,
  });
  const s = { p, kind, title: { agy: 'Antigravity', claude: 'Claude Code' }[kind] ?? 'Ubuntu', alive: true, buf: [], size: 0 };
  sessions.set(id, s);
  p.onData((d) => {
    const b = Buffer.from(d);
    s.buf.push(b);
    s.size += b.length;
    while (s.size > MAX_BUF && s.buf.length > 1) s.size -= s.buf.shift().length;
    broadcast({ type: 'output', id, data: b.toString('base64') });
  });
  p.onExit(({ exitCode }) => {
    s.alive = false;
    broadcast({ type: 'exit', id, code: exitCode });
  });
  return id;
}

const methods = {
  createSession: (kind, cols, rows) => create(kind, cols, rows),
  write: (id, data) => sessions.get(id)?.alive && sessions.get(id).p.write(data),
  resize: (id, cols, rows) => sessions.get(id)?.alive && sessions.get(id).p.resize(cols, rows),
  close: (id) => {
    const s = sessions.get(id);
    if (!s) return;
    if (s.alive) s.p.kill();
    sessions.delete(id);
  },
  listSessions: () => [...sessions].map(([id, s]) => ({ id, kind: s.kind, title: s.title, alive: s.alive })),
  getState: () => ({ host: 'dev', ubuntu: 'ready' }),
  installUbuntu: () => {},
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, path: '/bridge' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === 'attach') {
      const s = sessions.get(msg.args[0]);
      if (s) ws.send(JSON.stringify({ type: 'output', id: msg.args[0], data: Buffer.concat(s.buf).toString('base64') }));
      if (s) ws.send(JSON.stringify({ type: 'replayed', id: msg.args[0] }));
      return;
    }
    const value = methods[msg.method]?.(...(msg.args ?? []));
    if (msg.call !== undefined) ws.send(JSON.stringify({ reply: msg.call, value }));
  });
});
console.log(`dev bridge on ws://127.0.0.1:${PORT}/bridge`);
