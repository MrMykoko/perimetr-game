import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const menuAssets = new Map([
  ['/assets/menu-perimeter.png', await readFile(resolve(root, 'dist/assets/menu-perimeter.png'))],
  ['/assets/menu-ruins.png', await readFile(resolve(root, 'dist/assets/menu-ruins.png'))]
]);
const port = clamp(process.env.PORT || 3000, 1, 65535);
const host = process.env.HOST || '0.0.0.0';
const roomLifetimeMs = 45 * 60 * 1000;
const onlineWindowMs = 12 * 1000;
const classes = new Set(['assault', 'medic', 'engineer', 'heavy']);
const rooms = new Map();

function clamp(value, min, max) {
  value = Number(value);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

function cleanName(value) {
  return String(value || 'Игрок').trim().slice(0, 24).replace(/[<>]/g, '') || 'Игрок';
}

function makeToken() {
  return randomUUID() + randomUUID();
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join('');
}

function json(response, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function fail(response, message, status = 400) {
  json(response, { error: message }, status);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Некорректный JSON.'), { status: 400 });
  }
}

function authToken(request) {
  return String(request.headers.authorization || '').replace(/^Bearer /, '');
}

function publicPlayers(room) {
  const time = Date.now();
  return [...room.players.values()].map(player => ({
    id: player.token.slice(0, 36),
    name: player.name,
    klass: player.klass,
    input: player.input,
    online: time - player.updatedAt < onlineWindowMs
  }));
}

function touchPlayer(player) {
  player.updatedAt = Date.now();
}

function pruneRooms() {
  const time = Date.now();
  for (const [code, room] of rooms) {
    if (time - room.updatedAt > roomLifetimeMs) rooms.delete(code);
  }
}

setInterval(pruneRooms, 60_000).unref();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (request.method === 'GET' && (path === '/photos/' || /^\/photos\/(index\.html|[a-z0-9_-]+\.(png|webm))$/.test(path))) {
      try {
        const file = path === '/photos/' ? 'index.html' : path.slice('/photos/'.length);
        const data = await readFile(resolve(root, 'photos', file));
        response.writeHead(200, {'content-type':file.endsWith('.png')?'image/png':file.endsWith('.webm')?'video/webm':'text/html; charset=utf-8','content-length':data.length,'cache-control':'no-cache','x-content-type-options':'nosniff'});
        response.end(data);
      } catch { fail(response, 'Снимок не найден.', 404); }
      return;
    }

    if (request.method === 'GET' && (/^\/(art\.js|art\.css)$/.test(path) || /^\/assets\/previews\/[a-z0-9_-]+\.png$/.test(path))) {
      try {
        const asset = await readFile(resolve(root, 'dist', path.slice(1)));
        const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/png';
        response.writeHead(200, {'content-type':type,'content-length':asset.length,'cache-control':'no-cache','x-content-type-options':'nosniff'});
        response.end(asset);
      } catch { fail(response, 'Файл не найден.', 404); }
      return;
    }

    if ((path === '/' || path === '/index.html') && request.method === 'GET') {
      const indexHtml = await readFile(resolve(root, 'dist/index.html'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': indexHtml.length,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff'
      });
      response.end(indexHtml);
      return;
    }

    if (menuAssets.has(path) && request.method === 'GET') {
      const asset = menuAssets.get(path);
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': asset.length,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff'
      });
      response.end(asset);
      return;
    }

    if (path === '/health' && request.method === 'GET') {
      json(response, { ok: true, rooms: rooms.size });
      return;
    }

    if (!path.startsWith('/api/')) {
      fail(response, 'Не найдено.', 404);
      return;
    }

    if (path === '/api/rooms' && request.method === 'POST') {
      const body = await readJson(request);
      let code;
      do code = makeCode(); while (rooms.has(code));
      const token = makeToken();
      const time = Date.now();
      const player = {
        token,
        name: cleanName(body.name),
        klass: classes.has(body.klass) ? body.klass : 'assault',
        input: {},
        updatedAt: time
      };
      rooms.set(code, {
        code,
        hostToken: token,
        snapshot: {},
        status: 'lobby',
        updatedAt: time,
        players: new Map([[token, player]])
      });
      json(response, { code, token, id: token.slice(0, 36), host: true });
      return;
    }

    const match = path.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|class|input|state|close|leave))?$/);
    if (!match) {
      fail(response, 'Комната не найдена.', 404);
      return;
    }

    const [, code, rawAction] = match;
    const action = rawAction || 'read';
    const room = rooms.get(code);
    if (!room || Date.now() - room.updatedAt > roomLifetimeMs) {
      rooms.delete(code);
      fail(response, 'Комната закрыта или истекло время.', 404);
      return;
    }

    if (action === 'join' && request.method === 'POST') {
      if (room.status !== 'lobby') return fail(response, 'Матч уже начался.', 409);
      if (room.players.size >= 4) return fail(response, 'В комнате уже 4 игрока.', 409);
      const body = await readJson(request);
      const token = makeToken();
      const player = {
        token,
        name: cleanName(body.name),
        klass: classes.has(body.klass) ? body.klass : 'assault',
        input: {},
        updatedAt: Date.now()
      };
      room.players.set(token, player);
      json(response, { code, token, id: token.slice(0, 36), host: false });
      return;
    }

    const token = authToken(request);
    const player = room.players.get(token);
    const isHost = token === room.hostToken;
    if (!player) return fail(response, 'Нет доступа к комнате.', 403);

    if (action === 'class' && request.method === 'POST') {
      if (room.status !== 'lobby') return fail(response, 'Класс нельзя менять после запуска.', 409);
      const body = await readJson(request);
      if (!classes.has(body.klass)) return fail(response, 'Неизвестный класс.');
      player.klass = body.klass;
      touchPlayer(player);
      json(response, { ok: true, klass: player.klass });
      return;
    }

    if (action === 'leave' && request.method === 'POST') {
      if (isHost) {
        room.status = 'ended';
        room.updatedAt = Date.now();
      } else {
        room.players.delete(token);
      }
      json(response, { ok: true });
      return;
    }

    if (action === 'read' && request.method === 'GET') {
      json(response, {
        code,
        status: room.status,
        snapshot: room.snapshot,
        players: publicPlayers(room),
        hostId: room.hostToken.slice(0, 36),
        hostOnline: Date.now() - room.updatedAt < onlineWindowMs
      });
      return;
    }

    if (action === 'input' && request.method === 'POST') {
      const body = await readJson(request);
      player.input = {
        x: clamp(body.x, -40, 40),
        z: clamp(body.z, -40, 40),
        y: clamp(body.y, 0, 12),
        yaw: clamp(body.yaw, -1e6, 1e6),
        pitch: clamp(body.pitch, -1.5, 1.5),
        hp: clamp(body.hp, 0, 300),
        weapon: String(body.weapon || '').slice(0, 32),
        anim: ['reload','bandage','medkit','revive','armor','smoke','adrenaline','switch'].includes(body.anim)?body.anim:'',animProgress: clamp(body.animProgress,0,1),readyWave: Math.trunc(clamp(body.readyWave,0,100000)),
        level: Math.trunc(clamp(body.level, 1, 10)),
        credits: Math.trunc(clamp(body.credits, 0, 1e7)),
        healed: clamp(body.healed, 0, 1e7),
        revives: Math.trunc(clamp(body.revives, 0, 1e5)),
        shot: Math.trunc(clamp(body.shot, 0, 1e9)),
        action: String(body.action || '').slice(0, 60),
        actionSeq: Math.trunc(clamp(body.actionSeq, 0, 1e9)),
        stamp: Date.now()
      };
      touchPlayer(player);
      json(response, { ok: true });
      return;
    }

    if (action === 'state' && request.method === 'POST') {
      if (!isHost) return fail(response, 'Только хост управляет матчем.', 403);
      const body = await readJson(request);
      const serialized = JSON.stringify(body.snapshot || {});
      if (serialized.length > 90_000) return fail(response, 'Состояние слишком большое.', 413);
      room.snapshot = body.snapshot || {};
      room.status = body.status === 'ended' ? 'ended' : body.status === 'playing' ? 'playing' : 'lobby';
      room.updatedAt = Date.now();
      touchPlayer(player);
      json(response, { ok: true });
      return;
    }

    if (action === 'close' && request.method === 'POST') {
      if (!isHost) return fail(response, 'Только хост закрывает комнату.', 403);
      room.status = 'ended';
      room.updatedAt = Date.now();
      json(response, { ok: true });
      return;
    }

    fail(response, 'Неизвестное действие.', 405);
  } catch (error) {
    console.error(error);
    fail(response, error?.message || 'Ошибка сервера.', error?.status || 500);
  }
});

server.listen(port, host, () => {
  console.log(`ПЕРИМЕТР запущен: http://localhost:${port}`);
});

function shutdown(signal) {
  console.log(`\n${signal}: сервер останавливается…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
