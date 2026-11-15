import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type PersistenceBackend = 'postgres-pg' | 'turso-http' | 'supabase-rest' | 'sqlite-local';

export interface PersistenceStatus {
  backend: PersistenceBackend;
  remoteConnected: boolean;
  details: string;
  counts: {
    secrets: number;
    checkpoints: number;
    kv: number;
  };
  envConfigured: {
    databaseUrl: boolean;
    turso: boolean;
    supabase: boolean;
  };
}

let pgPool: Pool | null = null;
let remoteTablesReady = false;

function getTursoEndpoint(): { url: string; token: string } | null {
  const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  const token = (process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!rawUrl || !token) return null;
  const httpUrl = rawUrl.replace(/^libsql:\/\//i, 'https://').replace(/\/+$/, '');
  return { url: `${httpUrl}/v2/pipeline`, token };
}

function getSupabaseRestConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return null;
  return { url, key };
}

export function detectPersistenceBackend(): PersistenceBackend {
  if (process.env.DATABASE_URL && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) {
    return 'postgres-pg';
  }
  if (getTursoEndpoint()) {
    return 'turso-http';
  }
  if (getSupabaseRestConfig()) {
    return 'supabase-rest';
  }
  return 'sqlite-local';
}

function getPgPool(): Pool | null {
  if (!process.env.DATABASE_URL || !/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) return null;
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 6000,
      ssl: /localhost|127\.0\.0\.1/i.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

async function execTursoPipeline(statements: Array<{ sql: string; args?: any[] }>): Promise<any[]> {
  const turso = getTursoEndpoint();
  if (!turso) throw new Error('Turso not configured');
  const requests = statements.map((s) => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: (s.args || []).map((val) => {
        if (val === null || val === undefined) return { type: 'null' };
        if (typeof val === 'number' && Number.isInteger(val)) return { type: 'integer', value: String(val) };
        if (typeof val === 'number') return { type: 'float', value: val };
        return { type: 'text', value: String(val) };
      }),
    },
  }));
  requests.push({ type: 'close' } as any);

  const res = await fetch(turso.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${turso.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Turso HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.results || [];
}

function getLocalDb(): DatabaseSync {
  const dbPath = path.resolve(process.cwd(), '.nexus_local.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nexus_secrets (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nexus_checkpoints (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      git_commit TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nexus_kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

async function ensureRemoteSchema(): Promise<boolean> {
  if (remoteTablesReady) return true;
  const backend = detectPersistenceBackend();
  try {
    if (backend === 'postgres-pg') {
      const pool = getPgPool();
      if (!pool) return false;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS nexus_secrets (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nexus_checkpoints (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          file_count INTEGER NOT NULL,
          git_commit TEXT,
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nexus_kv (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
      remoteTablesReady = true;
      return true;
    }

    if (backend === 'turso-http') {
      await execTursoPipeline([
        { sql: `CREATE TABLE IF NOT EXISTS nexus_secrets (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)` },
        { sql: `CREATE TABLE IF NOT EXISTS nexus_checkpoints (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, file_count INTEGER NOT NULL, git_commit TEXT, snapshot_json TEXT NOT NULL)` },
        { sql: `CREATE TABLE IF NOT EXISTS nexus_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)` },
      ]);
      remoteTablesReady = true;
      return true;
    }

    if (backend === 'supabase-rest') {
      const sb = getSupabaseRestConfig();
      if (!sb) return false;
      const probe = await fetch(`${sb.url}/rest/v1/nexus_kv?select=k&limit=1`, {
        headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
        signal: AbortSignal.timeout(5000),
      });
      remoteTablesReady = probe.ok;
      return probe.ok;
    }
  } catch (err: any) {
    console.warn(`Remote persistence schema init skipped (${backend}):`, err?.message);
    return false;
  }
  return false;
}

export async function saveSecretsToPersistence(keys: any[]): Promise<{ backend: PersistenceBackend; syncedRemote: boolean }> {
  const backend = detectPersistenceBackend();
  const jsonPayload = JSON.stringify(keys);
  const now = Date.now();

  // Always write local SQLite mirror
  try {
    const db = getLocalDb();
    try {
      db.prepare(`INSERT INTO nexus_secrets (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run('default_pool', jsonPayload, now);
    } finally {
      db.close();
    }
  } catch {}

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      if (pool) {
        await pool.query(
          `INSERT INTO nexus_secrets (id, payload, updated_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
          ['default_pool', jsonPayload, now]
        );
        return { backend, syncedRemote: true };
      }
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      await execTursoPipeline([
        {
          sql: `INSERT INTO nexus_secrets (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          args: ['default_pool', jsonPayload, now],
        },
      ]);
      return { backend, syncedRemote: true };
    } catch {}
  }

  if (backend === 'supabase-rest' && (await ensureRemoteSchema())) {
    try {
      const sb = getSupabaseRestConfig()!;
      const res = await fetch(`${sb.url}/rest/v1/nexus_kv`, {
        method: 'POST',
        headers: {
          apikey: sb.key,
          Authorization: `Bearer ${sb.key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ k: 'nexus_secrets_default_pool', v: jsonPayload, updated_at: now }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { backend, syncedRemote: true };
    } catch {}
  }

  return { backend, syncedRemote: false };
}

export async function loadSecretsFromPersistence(): Promise<any[] | null> {
  const backend = detectPersistenceBackend();

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      const res = await pool?.query(`SELECT payload FROM nexus_secrets WHERE id = $1 LIMIT 1`, ['default_pool']);
      const raw = res?.rows?.[0]?.payload;
      if (raw) return JSON.parse(raw);
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      const results = await execTursoPipeline([
        { sql: `SELECT payload FROM nexus_secrets WHERE id = ? LIMIT 1`, args: ['default_pool'] },
      ]);
      const val = results?.[0]?.response?.result?.rows?.[0]?.[0]?.value;
      if (val) return JSON.parse(val);
    } catch {}
  }

  if (backend === 'supabase-rest' && (await ensureRemoteSchema())) {
    try {
      const sb = getSupabaseRestConfig()!;
      const res = await fetch(`${sb.url}/rest/v1/nexus_kv?k=eq.nexus_secrets_default_pool&select=v&limit=1`, {
        headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows?.[0]?.v) return JSON.parse(rows[0].v);
      }
    } catch {}
  }

  // Fallback to local SQLite
  try {
    const db = getLocalDb();
    try {
      const row = db.prepare(`SELECT payload FROM nexus_secrets WHERE id = ?`).get('default_pool') as any;
      if (row?.payload) return JSON.parse(row.payload);
    } finally {
      db.close();
    }
  } catch {}

  return null;
}

export async function saveKvToPersistence(key: string, value: any): Promise<boolean> {
  const backend = detectPersistenceBackend();
  const payload = JSON.stringify(value);
  const now = Date.now();

  try {
    const db = getLocalDb();
    try {
      db.prepare(
        `INSERT INTO nexus_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
      ).run(key, payload, now);
    } finally {
      db.close();
    }
  } catch {}

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      await pool?.query(
        `INSERT INTO nexus_kv (k, v, updated_at) VALUES ($1, $2, $3) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`,
        [key, payload, now]
      );
      return true;
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      await execTursoPipeline([
        {
          sql: `INSERT INTO nexus_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
          args: [key, payload, now],
        },
      ]);
      return true;
    } catch {}
  }

  if (backend === 'supabase-rest' && (await ensureRemoteSchema())) {
    try {
      const sb = getSupabaseRestConfig()!;
      const res = await fetch(`${sb.url}/rest/v1/nexus_kv`, {
        method: 'POST',
        headers: {
          apikey: sb.key,
          Authorization: `Bearer ${sb.key}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ k: key, v: payload, updated_at: now }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return true;
    } catch {}
  }

  return false;
}

export async function loadKvFromPersistence<T = any>(key: string): Promise<T | null> {
  const backend = detectPersistenceBackend();

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      const res = await pool?.query(`SELECT v FROM nexus_kv WHERE k = $1 LIMIT 1`, [key]);
      const raw = res?.rows?.[0]?.v;
      if (raw) return JSON.parse(raw);
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      const results = await execTursoPipeline([
        { sql: `SELECT v FROM nexus_kv WHERE k = ? LIMIT 1`, args: [key] },
      ]);
      const val = results?.[0]?.response?.result?.rows?.[0]?.[0]?.value;
      if (val) return JSON.parse(String(val));
    } catch {}
  }

  if (backend === 'supabase-rest' && (await ensureRemoteSchema())) {
    try {
      const sb = getSupabaseRestConfig()!;
      const res = await fetch(`${sb.url}/rest/v1/nexus_kv?k=eq.${encodeURIComponent(key)}&select=v&limit=1`, {
        headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows?.[0]?.v) return JSON.parse(rows[0].v);
      }
    } catch {}
  }

  try {
    const db = getLocalDb();
    try {
      const row = db.prepare(`SELECT v FROM nexus_kv WHERE k = ?`).get(key) as any;
      if (row?.v) return JSON.parse(row.v);
    } finally {
      db.close();
    }
  } catch {}

  return null;
}

export interface RemoteCheckpointSnapshot {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  gitCommit?: string;
  files: Record<string, string>;
}

export async function saveCheckpointToPersistence(snapshot: RemoteCheckpointSnapshot): Promise<boolean> {
  const backend = detectPersistenceBackend();
  const payload = JSON.stringify(snapshot.files);

  try {
    const db = getLocalDb();
    try {
      db.prepare(
        `INSERT INTO nexus_checkpoints (id, label, created_at, file_count, git_commit, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, snapshot_json = excluded.snapshot_json`
      ).run(snapshot.id, snapshot.label, snapshot.createdAt, snapshot.fileCount, snapshot.gitCommit || null, payload);
    } finally {
      db.close();
    }
  } catch {}

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      await pool?.query(
        `INSERT INTO nexus_checkpoints (id, label, created_at, file_count, git_commit, snapshot_json) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, snapshot_json = EXCLUDED.snapshot_json`,
        [snapshot.id, snapshot.label, snapshot.createdAt, snapshot.fileCount, snapshot.gitCommit || null, payload]
      );
      return true;
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      await execTursoPipeline([
        {
          sql: `INSERT INTO nexus_checkpoints (id, label, created_at, file_count, git_commit, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET label = excluded.label, snapshot_json = excluded.snapshot_json`,
          args: [snapshot.id, snapshot.label, snapshot.createdAt, snapshot.fileCount, snapshot.gitCommit || null, payload],
        },
      ]);
      return true;
    } catch {}
  }

  return false;
}

export async function loadCheckpointFromPersistence(id: string): Promise<RemoteCheckpointSnapshot | null> {
  const backend = detectPersistenceBackend();

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      const res = await pool?.query(`SELECT * FROM nexus_checkpoints WHERE id = $1 LIMIT 1`, [id]);
      const r = res?.rows?.[0];
      if (r) {
        return {
          id: r.id,
          label: r.label,
          createdAt: Number(r.created_at),
          fileCount: Number(r.file_count),
          gitCommit: r.git_commit || undefined,
          files: JSON.parse(r.snapshot_json),
        };
      }
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      const results = await execTursoPipeline([
        { sql: `SELECT id, label, created_at, file_count, git_commit, snapshot_json FROM nexus_checkpoints WHERE id = ? LIMIT 1`, args: [id] },
      ]);
      const row = results?.[0]?.response?.result?.rows?.[0];
      if (row) {
        return {
          id: String(row[0]?.value),
          label: String(row[1]?.value),
          createdAt: Number(row[2]?.value || 0),
          fileCount: Number(row[3]?.value || 0),
          gitCommit: row[4]?.value ? String(row[4].value) : undefined,
          files: JSON.parse(String(row[5]?.value || '{}')),
        };
      }
    } catch {}
  }

  try {
    const db = getLocalDb();
    try {
      const r = db.prepare(`SELECT * FROM nexus_checkpoints WHERE id = ?`).get(id) as any;
      if (r) {
        return {
          id: r.id,
          label: r.label,
          createdAt: Number(r.created_at),
          fileCount: Number(r.file_count),
          gitCommit: r.git_commit || undefined,
          files: JSON.parse(r.snapshot_json),
        };
      }
    } finally {
      db.close();
    }
  } catch {}

  return null;
}

export async function listCheckpointsFromPersistence(): Promise<Array<{ id: string; label: string; createdAt: number; fileCount: number; gitCommit?: string }>> {
  const backend = detectPersistenceBackend();

  if (backend === 'postgres-pg' && (await ensureRemoteSchema())) {
    try {
      const pool = getPgPool();
      const res = await pool?.query(`SELECT id, label, created_at, file_count, git_commit FROM nexus_checkpoints ORDER BY created_at DESC LIMIT 20`);
      if (res?.rows) {
        return res.rows.map((r: any) => ({
          id: r.id,
          label: r.label,
          createdAt: Number(r.created_at),
          fileCount: Number(r.file_count),
          gitCommit: r.git_commit || undefined,
        }));
      }
    } catch {}
  }

  if (backend === 'turso-http' && (await ensureRemoteSchema())) {
    try {
      const results = await execTursoPipeline([
        { sql: `SELECT id, label, created_at, file_count, git_commit FROM nexus_checkpoints ORDER BY created_at DESC LIMIT 20` },
      ]);
      const rows = results?.[0]?.response?.result?.rows || [];
      return rows.map((row: any[]) => ({
        id: String(row[0]?.value),
        label: String(row[1]?.value),
        createdAt: Number(row[2]?.value || 0),
        fileCount: Number(row[3]?.value || 0),
        gitCommit: row[4]?.value ? String(row[4].value) : undefined,
      }));
    } catch {}
  }

  try {
    const db = getLocalDb();
    try {
      const rows = db.prepare(`SELECT id, label, created_at, file_count, git_commit FROM nexus_checkpoints ORDER BY created_at DESC LIMIT 20`).all() as any[];
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        createdAt: Number(r.created_at),
        fileCount: Number(r.file_count),
        gitCommit: r.git_commit || undefined,
      }));
    } finally {
      db.close();
    }
  } catch {}

  return [];
}

export async function initPersistenceStore(): Promise<PersistenceStatus> {
  const secretsFile = path.resolve(process.cwd(), '.secrets.json');
  const hasLocalSecrets = await fs.access(secretsFile).then(() => true).catch(() => false);
  if (!hasLocalSecrets) {
    const remoteKeys = await loadSecretsFromPersistence();
    if (Array.isArray(remoteKeys) && remoteKeys.length > 0) {
      await fs.writeFile(secretsFile, JSON.stringify(remoteKeys, null, 2), 'utf-8').catch(() => {});
    }
  } else {
    // Seed remote if local exists and remote empty
    const remoteKeys = await loadSecretsFromPersistence();
    if (!remoteKeys || remoteKeys.length === 0) {
      const raw = await fs.readFile(secretsFile, 'utf-8').catch(() => '');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          await saveSecretsToPersistence(parsed).catch(() => {});
        }
      }
    }
  }
  return await getPersistenceStatus();
}

export async function getPersistenceStatus(): Promise<PersistenceStatus> {
  const backend = detectPersistenceBackend();
  const remoteConnected = backend !== 'sqlite-local' ? await ensureRemoteSchema() : false;
  let secretsCount = 0;
  let checkpointsCount = 0;
  let kvCount = 0;

  try {
    if (backend === 'postgres-pg' && remoteConnected) {
      const pool = getPgPool()!;
      const [s, c, k] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM nexus_secrets`),
        pool.query(`SELECT COUNT(*)::int AS c FROM nexus_checkpoints`),
        pool.query(`SELECT COUNT(*)::int AS c FROM nexus_kv`),
      ]);
      secretsCount = s.rows[0]?.c || 0;
      checkpointsCount = c.rows[0]?.c || 0;
      kvCount = k.rows[0]?.c || 0;
    } else if (backend === 'turso-http' && remoteConnected) {
      const res = await execTursoPipeline([
        { sql: `SELECT COUNT(*) FROM nexus_secrets` },
        { sql: `SELECT COUNT(*) FROM nexus_checkpoints` },
        { sql: `SELECT COUNT(*) FROM nexus_kv` },
      ]);
      secretsCount = Number(res?.[0]?.response?.result?.rows?.[0]?.[0]?.value || 0);
      checkpointsCount = Number(res?.[1]?.response?.result?.rows?.[0]?.[0]?.value || 0);
      kvCount = Number(res?.[2]?.response?.result?.rows?.[0]?.[0]?.value || 0);
    } else {
      const db = getLocalDb();
      try {
        secretsCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM nexus_secrets`).get() as any)?.c || 0);
        checkpointsCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM nexus_checkpoints`).get() as any)?.c || 0);
        kvCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM nexus_kv`).get() as any)?.c || 0);
      } finally {
        db.close();
      }
    }
  } catch {}

  const detailsMap: Record<PersistenceBackend, string> = {
    'postgres-pg': remoteConnected
      ? 'Connected to PostgreSQL (DATABASE_URL) — secrets & checkpoints survive container restarts.'
      : 'DATABASE_URL detected but connection failed; falling back to local SQLite.',
    'turso-http': remoteConnected
      ? 'Connected to Turso libSQL HTTP API — serverless edge persistence active.'
      : 'Turso credentials detected but handshake failed; falling back to local SQLite.',
    'supabase-rest': remoteConnected
      ? 'Connected to Supabase PostgREST API (nexus_kv table active).'
      : 'Supabase env detected; create table "nexus_kv (k text primary key, v text, updated_at bigint)" in Supabase.',
    'sqlite-local': 'Using persistent local SQLite (.nexus_local.db). Set DATABASE_URL (Postgres/Neon/Supabase) or TURSO_DATABASE_URL for remote cloud persistence across Render restarts.',
  };

  return {
    backend,
    remoteConnected,
    details: detailsMap[backend],
    counts: { secrets: secretsCount, checkpoints: checkpointsCount, kv: kvCount },
    envConfigured: {
      databaseUrl: Boolean(process.env.DATABASE_URL),
      turso: Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN),
      supabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)),
    },
  };
}
