// Load test for a LOCAL Sync server: how many concurrent users before it slows down. Never point it at production
// (BASE defaults to 127.0.0.1, so nothing leaves this machine). Node 22+, no dependencies.
//
//   1) docker compose up -d mysql
//      docker exec sync-mysql-1 mysql -uroot -proot -e "CREATE DATABASE IF NOT EXISTS mirattic_loadtest; GRANT ALL ON mirattic_loadtest.* TO 'mirattic'@'%'"
//   2) cd server && ./mvnw -q package -DskipTests && DB_URL=jdbc:mysql://localhost:3306/mirattic_loadtest \
//        AUTH_ISSUER=http://127.0.0.1:9999 AUTH_CLIENT_SECRET=loadtest SERVER_PORT=8091 java -jar target/server-0.0.1-SNAPSHOT.jar
//   3) ulimit -n 30000 && node loadtest/run.mjs                     # cleanup: node loadtest/run.mjs clean
//
// Or a server on another machine of the LAN (SSH as USER@IP, BASE http://IP:PORT): its database is reached through
// `ssh USER@IP docker exec MYSQL_CONTAINER`, and the server reads our JWKS through `ssh -R 9999:127.0.0.1:9999`
// at http://host.docker.internal:9999 (ISSUER), so nothing listens on the LAN here.
//
// Its own database: another server on the same one (the dev server) would close these rooms as empty, since it
// sees none of their connections. The jar, not spring-boot:run, whose JVM flags (C1 only) make it slower.
//
// This script serves the JWKS at :9999 and signs its own access tokens (like the tests' AuthStub); its users are
// rows written straight into MySQL (display name `loadtest-…`), in rooms of ROOM_SIZE joined by code.
// Each step adds users, then measures for STEP_SECONDS: hosts send a pause every PLAYBACK_EVERY s, everyone chats
// every CHAT_EVERY s, and the delay until each other connected member receives it is recorded. Stops at the first
// step whose p95 passes MAX_P95_MS, or where over 1% of new connections fail, deliveries are lost or sends refused.
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const env = (k, d) => process.env[k] ?? d;
const BASE = env('BASE', 'http://127.0.0.1:8091');
const STEPS = env('STEPS', '100,250,500,1000,1500,2000,3000').split(',').map(Number);
const ROOM_SIZE = +env('ROOM_SIZE', 4); // server limit: 8
const STEP_SECONDS = +env('STEP_SECONDS', 30);
const PLAYBACK_EVERY = +env('PLAYBACK_EVERY', 5);
const CHAT_EVERY = +env('CHAT_EVERY', 15);
const MAX_P95_MS = +env('MAX_P95_MS', 500);
const DB = 'mirattic_loadtest'; // fixed: `clean` deletes by name pattern, safe only in this dedicated database
const MYSQL = ['exec', '-i', env('MYSQL_CONTAINER', 'sync-mysql-1'), 'mysql', '-umirattic', '-pmirattic', DB];
const SSH = process.env.SSH; // USER@IP of a LAN machine running the server and its database
const ISSUER = env('ISSUER', 'http://127.0.0.1:9999');

// Load only on this machine's server, or on a LAN machine's reached by SSH; writes (and `clean` deletes) only in
// that machine's load-test database.
const host = new URL(BASE).hostname;
const lan = isIPv4(host) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host); // an address, not a name
const localDocker = () =>
	execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).toString().startsWith('unix://');
if (SSH ? !lan || SSH.split('@').at(-1) !== host : !['127.0.0.1', 'localhost', '[::1]'].includes(host) || !localDocker()) {
	console.error(`refusing: this machine's server and Docker, or a LAN server with SSH to the same IP (server ${BASE}, ssh ${SSH ?? '-'})`);
	process.exit(1);
}
// A timeout: docker exec occasionally hangs, and this blocks the whole process.
const sql = (q) => SSH
	? execFileSync('ssh', ['-o', 'BatchMode=yes', SSH, `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH docker ${MYSQL.join(' ')}`],
		{ input: q, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 })
	: execFileSync('docker', MYSQL, { input: q, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 });

if (process.argv[2] === 'clean') {
	// Rooms first: room_members cascades from both, chat_messages from rooms.
	sql(`DELETE FROM rooms WHERE title = 'loadtest';
		DELETE FROM users WHERE display_name LIKE 'loadtest-%';`);
	console.log('loadtest users and rooms deleted');
	process.exit(0);
}

// --- Auth stand-in: the server reads this JWKS (AUTH_ISSUER), we sign tokens with the private key ---
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID(); // a new kid each run: the server refetches the JWKS instead of using a stale key
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
const jwksServer = createServer((req, res) => res.end(jwks)).listen(9999, '127.0.0.1');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub) {
	const now = Math.floor(Date.now() / 1000);
	const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64({
		iss: ISSUER, sub, aud: 'mirattic-sync', scope: ['openid'], iat: now, exp: now + 7200,
	})}`;
	return `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}`;
}

// --- Metrics ---
let latencies = [];
let failures = 0;
let errors = 0;
const errorCodes = {};
const loopDelay = monitorEventLoopDelay();
loopDelay.enable();
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

// --- One user: REST to join the room, then a WebSocket in it ---
async function api(t, method, path, body) {
	const res = await fetch(BASE + path, {
		method, redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
		body: body && JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
	return res.json();
}

// "room|position" or chat text → { at, expected: other members connected when sent, got: those who received it }. Only sends made
// while a step measures are recorded, so every delivery counted belongs to that step.
const sent = new Map();
let measuring = false;
let step = [];
const users = [];
const inRoom = new Map(); // room id → its users
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const friendCode = () => Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 31)]).join('');

async function addUsers(count) {
	const fresh = Array.from({ length: count }, () => ({ id: randomUUID() }));
	const now = Date.now();
	sql(`INSERT INTO users (id, display_name, friend_code, presence_visibility, position_visibility, created_at) VALUES ${fresh
		.map((u, i) => `('${u.id}', 'loadtest-${users.length + i}', '${friendCode()}', 'FRIENDS', 'ROOM_ONLY', ${now})`)
		.join(',')};`);
	// Hosts first (members join their rooms by code), in batches of 50: a real crowd doesn't arrive in one millisecond.
	const indexed = fresh.map((u, i) => [u, users.length + i]);
	for (const group of [indexed.filter(([, n]) => n % ROOM_SIZE === 0), indexed.filter(([, n]) => n % ROOM_SIZE !== 0)]) {
		for (let i = 0; i < group.length; i += 50) {
			await Promise.all(group.slice(i, i + 50).map(([u, n]) => connect(u, n)));
		}
	}
	users.push(...fresh);
}

const rooms = []; // { id, code }
// Settles at the first of `events` (ok, fail) or after 10 s (fail); the timer is cleared either way.
function within10s(what, events) {
	let timer;
	return new Promise((ok, fail) => {
		timer = setTimeout(() => fail(new Error(`${what} timed out`)), 10_000);
		events(ok, fail);
	}).finally(() => clearTimeout(timer));
}

async function connect(u, index) {
	let ws;
	try {
		u.token = token(u.id);
		if (index % ROOM_SIZE === 0) {
			const room = await api(u.token, 'POST', '/api/rooms', {
				content: { provider: 'youtube', contentId: 'aqz-KE-bpKQ', title: 'loadtest' }, inviteIds: [],
			});
			rooms[index / ROOM_SIZE] = room;
			u.host = true;
		} else {
			await api(u.token, 'POST', '/api/rooms/join', { code: rooms[Math.floor(index / ROOM_SIZE)].code });
		}
		u.room = rooms[Math.floor(index / ROOM_SIZE)].id;
		const { ticket } = await api(u.token, 'POST', '/api/ws-ticket');
		ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?ticket=${ticket}`);
		await within10s('ws handshake', (ok, fail) => {
			ws.onopen = ok;
			ws.onerror = () => fail(new Error('ws handshake failed'));
		});
		// In the room once the server answers the join with the room's playback state; only then an expected recipient.
		await within10s('room join', (ok, fail) => {
			ws.onmessage = (m) => {
				const event = JSON.parse(m.data);
				if (event.type === 'playback:update') ok();
				else if (event.type === 'error') fail(new Error(`room join: ${event.payload.code}`));
			};
			ws.onclose = () => fail(new Error('closed while joining'));
			ws.send(JSON.stringify({ type: 'room:join', roomId: u.room }));
		});
		ws.onmessage = (m) => received(u, JSON.parse(m.data));
		ws.onclose = () => u.ws === ws && (failures++, (u.ws = null));
		u.ws = ws;
		inRoom.set(u.room, [...(inRoom.get(u.room) ?? []), u]);
		start(u);
	} catch (e) {
		ws?.close(); // a late handshake would otherwise leave an untracked connection on the server
		failures++;
		if (failures <= 5) console.error(`user ${index}: ${e.message}`);
	}
}

function received(u, event) {
	const now = Date.now();
	let key;
	if (event.type === 'playback:update' && event.userId !== u.id) key = `${event.roomId}|${event.payload.positionMs}`;
	else if (event.type === 'chat:message' && event.userId !== u.id) key = event.payload.text;
	else if (event.type === 'error') errors++, (errorCodes[event.payload.code] = (errorCodes[event.payload.code] ?? 0) + 1);
	const record = key && sent.get(key);
	if (record?.expected.has(u) && !record.got.has(u)) {
		record.got.add(u);
		latencies.push(now - record.at);
	}
}

// Each user on its own clock, started at a random point of the period so users don't all send in the same tick.
const timers = [];
function every(u, seconds, send) {
	const run = () => u.ws?.readyState === WebSocket.OPEN && send(Date.now());
	timers.push(setTimeout(() => {
		run();
		timers.push(setInterval(run, seconds * 1000));
	}, Math.random() * seconds * 1000));
}
function record(u, key, now) {
	if (!measuring) return;
	const expected = new Set(inRoom.get(u.room).filter((o) => o !== u && o.ws?.readyState === WebSocket.OPEN));
	const r = { at: now, expected, got: new Set() };
	sent.set(key, r);
	step.push(r);
}
function start(u) {
	if (u.host) every(u, PLAYBACK_EVERY, (now) => {
		const position = Math.floor(Math.random() * 1e9);
		record(u, `${u.room}|${position}`, now);
		u.ws.send(JSON.stringify({ type: 'playback:pause', roomId: u.room, payload: { positionMs: position, capturedAt: now } }));
	});
	every(u, CHAT_EVERY, (now) => {
		const text = `lt-${randomUUID()}`;
		record(u, text, now);
		u.ws.send(JSON.stringify({ type: 'chat:message', roomId: u.room, payload: { text } }));
	});
}

// --- Steps ---
const GRACE_MS = 3000; // after a step, for its last sends to arrive
console.log(`server ${BASE}, rooms of ${ROOM_SIZE}, ${STEP_SECONDS}s per step, p95 limit ${MAX_P95_MS}ms`);
console.log('users  connected  fail  errors  lost%  recv/s   p50   p95   p99   max  (ms)  client lag p99');
let last = 0;
for (const target of STEPS) {
	const failedBefore = failures;
	await addUsers(target - users.length);
	latencies = [];
	errors = 0;
	step = [];
	sent.clear();
	loopDelay.reset();
	measuring = true;
	await new Promise((r) => setTimeout(r, STEP_SECONDS * 1000));
	measuring = false;
	await new Promise((r) => setTimeout(r, GRACE_MS));
	const l = latencies.sort((a, b) => a - b);
	const connected = users.filter((u) => u.ws?.readyState === WebSocket.OPEN).length;
	const expected = step.reduce((n, r) => n + r.expected.size, 0);
	const lost = expected ? 1 - step.reduce((n, r) => n + r.got.size, 0) / expected : 1;
	const failed = failures - failedBefore; // connections that failed or dropped during this step
	const p95 = pct(l, 0.95);
	console.log(
		[target, connected, failed, errors, (lost * 100).toFixed(1), Math.round(l.length / STEP_SECONDS), pct(l, 0.5), p95, pct(l, 0.99), l.at(-1) ?? 0]
			.map((v) => String(v).padStart(5)).join('  ') + `        ${Math.round(loopDelay.percentile(99) / 1e6)}ms`,
	);
	// No sends to count (nobody connected) counts as all lost.
	if (p95 > MAX_P95_MS || failed > (target - last) * 0.01 || lost > 0.01 || errors > step.length * 0.01) {
		console.log(`→ limit reached at ${target} users (last good step: ${last || 'none'})`);
		break;
	}
	last = target;
}
if (loopDelay.percentile(99) / 1e6 > 100) console.log('note: the client itself lagged (>100ms); the numbers are pessimistic');
if (errors) console.log('errors:', errorCodes);
console.log('cleanup: node loadtest/run.mjs clean');
timers.forEach(clearTimeout);
users.forEach((u) => u.ws?.close());
jwksServer.close();
setTimeout(() => process.exit(0), 1000);
