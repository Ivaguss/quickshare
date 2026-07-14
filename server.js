// QuickShare — общая комната для обмена текстом, фото и файлами между устройствами.
// Стек: Express (HTTP + статика) + ws (мгновенная синхронизация) + multer (загрузка файлов).
// Данные хранятся в памяти процесса и автоматически удаляются по таймауту — это временный буфер обмена,
// а не постоянное хранилище.

import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Лимиты (можно менять через переменные окружения) ────────────────────────────
const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 30 * 1024 * 1024; // 30 МБ на файл
const ROOM_QUOTA_BYTES = Number(process.env.ROOM_QUOTA_BYTES) || 150 * 1024 * 1024; // 150 МБ на комнату
const MAX_ITEMS = Number(process.env.MAX_ITEMS) || 200; // элементов в комнате
const ITEM_TTL_MS = Number(process.env.ITEM_TTL_MS) || 6 * 60 * 60 * 1000; // 6 часов

// ── Хранилище комнат в памяти ───────────────────────────────────────────────────
// room = { items: [ {id, kind, ts, ...} ], files: Map<id, Buffer>, bytes, clients: Set<ws> }
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { items: [], files: new Map(), bytes: 0, clients: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function publicItem(item) {
  // То, что отдаём клиентам (без бинарных данных файла).
  const { buffer, ...rest } = item;
  return rest;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function removeItem(code, room, id) {
  const idx = room.items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  const [item] = room.items.splice(idx, 1);
  if (item.kind === 'file') {
    room.files.delete(id);
    room.bytes -= item.size || 0;
  }
  broadcast(room, { type: 'remove', id });
  maybeDropRoom(code, room);
  return true;
}

function maybeDropRoom(code, room) {
  if (room.items.length === 0 && room.clients.size === 0) rooms.delete(code);
}

function addItem(code, room, item) {
  room.items.push(item);
  // Ограничение по количеству — вытесняем самые старые.
  while (room.items.length > MAX_ITEMS) {
    const old = room.items.shift();
    if (old.kind === 'file') {
      room.files.delete(old.id);
      room.bytes -= old.size || 0;
    }
    broadcast(room, { type: 'remove', id: old.id });
  }
  broadcast(room, { type: 'add', item: publicItem(item) });
}

// Периодическая очистка протухших элементов.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const expired = room.items.filter((i) => now - i.ts > ITEM_TTL_MS);
    for (const i of expired) removeItem(code, room, i.id);
    maybeDropRoom(code, room);
  }
}, 60 * 1000).unref();

// ── HTTP ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

function validRoom(code) {
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(code);
}

// Загрузка файла (в т.ч. фото).
app.post('/api/:room/file', (req, res) => {
  const code = req.params.room;
  if (!validRoom(code)) return res.status(400).json({ error: 'bad room' });

  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Файл больше лимита (${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ)`
        : 'Ошибка загрузки';
      return res.status(413).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const room = getRoom(code);
    if (room.bytes + req.file.size > ROOM_QUOTA_BYTES) {
      return res.status(413).json({
        error: `Превышен лимит комнаты (${Math.round(ROOM_QUOTA_BYTES / 1024 / 1024)} МБ). Удалите что-нибудь.`,
      });
    }

    const id = crypto.randomUUID();
    const item = {
      id,
      kind: 'file',
      name: req.file.originalname || 'file',
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      buffer: req.file.buffer,
      ts: Date.now(),
    };
    room.files.set(id, req.file.buffer);
    room.bytes += req.file.size;
    addItem(code, room, item);
    res.json({ item: publicItem(item) });
  });
});

// Скачивание файла.
app.get('/api/:room/file/:id', (req, res) => {
  const { room: code, id } = req.params;
  const room = rooms.get(code);
  const item = room && room.items.find((i) => i.id === id && i.kind === 'file');
  if (!room || !item) return res.status(404).send('Not found');
  const buf = room.files.get(id);
  if (!buf) return res.status(404).send('Not found');

  res.setHeader('Content-Type', item.mime);
  const inline = req.query.inline === '1' && item.mime.startsWith('image/');
  const dispo = inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${dispo}; filename*=UTF-8''${encodeURIComponent(item.name)}`);
  res.send(buf);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ── WebSocket ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('room');
  if (!validRoom(code)) {
    ws.close(1008, 'bad room');
    return;
  }

  const room = getRoom(code);
  room.clients.add(ws);
  ws.roomCode = code;

  // Отправляем текущее состояние комнаты.
  ws.send(JSON.stringify({ type: 'init', items: room.items.map(publicItem) }));
  broadcast(room, { type: 'presence', count: room.clients.size });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'text' && typeof msg.text === 'string') {
      const text = msg.text.slice(0, 100000).trim();
      if (!text) return;
      const item = { id: crypto.randomUUID(), kind: 'text', text, ts: Date.now() };
      addItem(code, room, item);
    } else if (msg.type === 'remove' && typeof msg.id === 'string') {
      removeItem(code, room, msg.id);
    } else if (msg.type === 'clear') {
      const ids = room.items.map((i) => i.id);
      for (const id of ids) removeItem(code, room, id);
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcast(room, { type: 'presence', count: room.clients.size });
    maybeDropRoom(code, room);
  });
});

// Пинг для поддержания соединения живым (некоторые хостинги рвут idle-сокеты).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.ping();
  }
}, 30 * 1000).unref();

server.listen(PORT, () => {
  console.log(`QuickShare запущен на http://localhost:${PORT}`);
});
