import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import path from 'node:path';
import fs from 'node:fs';

export const AUTH_COOKIE = 'flow_session';
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Challenge = { email: string; codeHash: string; expiresAt: number; attempts: number; sentAt: number; consumed: boolean };
type Session = { tokenHash: string; userId: string; learnerId: string; email: string; expiresAt: number; revoked: boolean };
const memory = globalThis as typeof globalThis & { flowAuthMemory?: { challenges: Map<string, Challenge>; sessions: Map<string, Session>; users: Map<string, { userId: string; learnerId: string }> } };
const inMemory = memory.flowAuthMemory ??= { challenges: new Map(), sessions: new Map(), users: new Map() };
let database: Database.Database | undefined;

function db(): Database.Database | null {
  if ((process.env.FLOW_STORAGE ?? 'memory') !== 'sqlite') return null;
  if (!database) {
    const filename = process.env.FLOW_SQLITE_PATH ?? path.join(process.cwd(), '.data', 'flow.sqlite');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    database = new Database(filename);
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE IF NOT EXISTS auth_users (user_id TEXT PRIMARY KEY, learner_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_challenges (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL, sent_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(user_id), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
  }
  return database;
}

function secret(): string {
  const value = process.env.FLOW_AUTH_SECRET;
  if (!value || value.length < 32) throw new Error('FLOW_AUTH_SECRET must contain at least 32 characters');
  return value;
}
function codeDigest(email: string, code: string): string { return createHmac('sha256', secret()).update(`${email}:${code}`).digest('hex'); }
function tokenDigest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function same(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string' || email.length > 254) throw new Error('请输入有效邮箱地址');
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('请输入有效邮箱地址');
  return value;
}

export type AuthenticatedUser = { userId: string; learnerId: string; email: string };

export async function sendLoginCode(rawEmail: unknown): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const now = Date.now();
  const store = db();
  const previous = store ? store.prepare('SELECT sent_at AS sentAt FROM auth_challenges WHERE email=?').get(email) as { sentAt: number } | undefined : inMemory.challenges.get(email);
  if (previous && now - previous.sentAt < RESEND_MS) throw new Error('验证码发送过于频繁，请稍后再试');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const challenge: Challenge = { email, codeHash: codeDigest(email, code), expiresAt: now + CODE_TTL_MS, attempts: 0, sentAt: now, consumed: false };
  const host = process.env.QQ_SMTP_HOST ?? 'smtp.qq.com';
  const port = Number(process.env.QQ_SMTP_PORT ?? '465');
  const user = process.env.QQ_SMTP_USER;
  const pass = process.env.QQ_SMTP_AUTH_CODE;
  if (!user || !pass) throw new Error('服务端尚未配置 QQ 邮箱 SMTP');
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  await transport.sendMail({ from: process.env.QQ_SMTP_FROM ?? user, to: email, subject: 'Flow 登录验证码', text: `你的 Flow 登录验证码是 ${code}，10 分钟内有效。请勿将验证码告知他人。` });
  if (store) store.prepare(`INSERT INTO auth_challenges(email,code_hash,expires_at,attempts,sent_at,consumed) VALUES(?,?,?,?,?,0)
    ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at,consumed=0`).run(email, challenge.codeHash, challenge.expiresAt, 0, now);
  else inMemory.challenges.set(email, challenge);
}

export function verifyLoginCode(rawEmail: unknown, rawCode: unknown): { user: AuthenticatedUser; token: string; expiresAt: number } {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new Error('验证码错误或已失效');
  const now = Date.now();
  const store = db();
  const issue = store ? store.prepare('SELECT code_hash AS codeHash,expires_at AS expiresAt,attempts,sent_at AS sentAt,consumed FROM auth_challenges WHERE email=?').get(email) as (Challenge & { consumed: number }) | undefined : inMemory.challenges.get(email);
  if (!issue || issue.consumed || issue.expiresAt <= now || issue.attempts >= MAX_ATTEMPTS) throw new Error('验证码错误或已失效');
  const valid = same(issue.codeHash, codeDigest(email, code));
  if (!valid) {
    if (store) store.prepare('UPDATE auth_challenges SET attempts=attempts+1 WHERE email=?').run(email);
    else issue.attempts += 1;
    throw new Error('验证码错误或已失效');
  }
  const token = randomBytes(32).toString('base64url');
  const userId = store
    ? (() => { store.prepare('INSERT OR IGNORE INTO auth_users(user_id,learner_id,email,created_at) VALUES(?,?,?,?)').run(`usr_${randomBytes(16).toString('hex')}`, `learner_${randomBytes(16).toString('hex')}`, email, now); return store.prepare('SELECT user_id AS userId,learner_id AS learnerId FROM auth_users WHERE email=?').get(email) as { userId: string; learnerId: string }; })()
    : (inMemory.users.get(email) ?? (() => { const user = { userId: `usr_${randomBytes(16).toString('hex')}`, learnerId: `learner_${randomBytes(16).toString('hex')}` }; inMemory.users.set(email, user); return user; })());
  const expiresAt = now + SESSION_TTL_MS;
  if (store) {
    const transaction = store.transaction(() => {
      store.prepare('UPDATE auth_challenges SET consumed=1 WHERE email=? AND consumed=0').run(email);
      store.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenDigest(token), userId.userId, expiresAt);
    });
    transaction();
  } else {
    issue.consumed = true;
    inMemory.sessions.set(tokenDigest(token), { tokenHash: tokenDigest(token), userId: userId.userId, learnerId: userId.learnerId, email, expiresAt, revoked: false });
  }
  return { user: { ...userId, email }, token, expiresAt };
}

export function getAuthenticatedUser(token: string | undefined): AuthenticatedUser | null {
  if (!token) return null;
  const now = Date.now();
  const store = db();
  if (store) {
    const row = store.prepare(`SELECT u.user_id AS userId,u.learner_id AS learnerId,u.email AS email FROM auth_sessions s JOIN auth_users u ON u.user_id=s.user_id WHERE s.token_hash=? AND s.revoked=0 AND s.expires_at>?`).get(tokenDigest(token), now) as AuthenticatedUser | undefined;
    return row ?? null;
  }
  const row = inMemory.sessions.get(tokenDigest(token));
  return row && !row.revoked && row.expiresAt > now ? { userId: row.userId, learnerId: row.learnerId, email: row.email } : null;
}

export function revokeSession(token: string | undefined): void {
  if (!token) return;
  const store = db();
  if (store) store.prepare('UPDATE auth_sessions SET revoked=1 WHERE token_hash=?').run(tokenDigest(token));
  else { const session = inMemory.sessions.get(tokenDigest(token)); if (session) session.revoked = true; }
}
