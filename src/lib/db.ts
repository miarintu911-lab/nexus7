export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: any[];
  mode?: string;
  generatedHtml?: string;
  previewUrl?: string;
  lastRunDuration?: number;
  activeJobId?: string | null;
  activeJobStartedAt?: number | null;
}

const sessionWriteQueues = new Map<string, Promise<any>>();

function enqueueSessionWrite<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = sessionWriteQueues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const cleanup = next.finally(() => {
    if (sessionWriteQueues.get(id) === cleanup) {
      sessionWriteQueues.delete(id);
    }
  });
  sessionWriteQueues.set(id, cleanup);
  return next;
}

const DB_NAME = 'nexus_ai_studio_db';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported in this environment'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: any) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllSessions(): Promise<ChatSession[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const results: ChatSession[] = request.result || [];
        // Sort descending by updatedAt
        results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB getAllSessions failed, falling back to localStorage:', err);
    try {
      const raw = localStorage.getItem('nexus_sessions_fallback');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}

export async function getSession(id: string): Promise<ChatSession | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB getSession failed, checking fallback:', err);
    try {
      const all = await getAllSessions();
      return all.find(s => s.id === id) || null;
    } catch {
      return null;
    }
  }
}

export async function saveSession(session: ChatSession): Promise<void> {
  return enqueueSessionWrite(session.id, async () => {
    try {
      const db = await openDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(session);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (err) {
      console.warn('IndexedDB saveSession failed, saving to fallback:', err);
      try {
        const all = await getAllSessions();
        const idx = all.findIndex(s => s.id === session.id);
        if (idx >= 0) {
          all[idx] = session;
        } else {
          all.unshift(session);
        }
        localStorage.setItem('nexus_sessions_fallback', JSON.stringify(all));
      } catch {}
    }
  });
}

export async function updateSession(
  id: string,
  updater: (current: ChatSession) => ChatSession | null
): Promise<ChatSession | null> {
  return enqueueSessionWrite(id, async () => {
    const current = await getSession(id);
    if (!current) return null;
    const updated = updater(current);
    if (!updated) return current;
    try {
      const db = await openDB();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(updated);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (err) {
      console.warn('IndexedDB updateSession failed, saving to fallback:', err);
      try {
        const all = await getAllSessions();
        const idx = all.findIndex(s => s.id === updated.id);
        if (idx >= 0) {
          all[idx] = updated;
        } else {
          all.unshift(updated);
        }
        localStorage.setItem('nexus_sessions_fallback', JSON.stringify(all));
      } catch {}
    }
    return updated;
  });
}

export async function deleteSession(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('IndexedDB deleteSession failed:', err);
    try {
      const all = await getAllSessions();
      const filtered = all.filter(s => s.id !== id);
      localStorage.setItem('nexus_sessions_fallback', JSON.stringify(filtered));
    } catch {}
  }
}

export function generateSessionTitle(prompt: string): string {
  const clean = (prompt || '').trim().replace(/^["']|["']$/g, '');
  if (!clean) return 'New Canvas';
  if (clean.length <= 32) return clean;
  return clean.slice(0, 32) + '...';
}

export function extractHtmlFromChatMessages(messages: any[]): string | null {
  if (!Array.isArray(messages)) return null;

  const looksLikeCompleteHtmlDoc = (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length < 180) return false;
    return /<!DOCTYPE\s+html/i.test(trimmed) || (/<html[\s>]/i.test(trimmed) && /<body[\s>]/i.test(trimmed));
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'model') {
      const text = m.parts?.[0]?.text || '';
      // Look for ```html ... ```
      const htmlBlockMatch = text.match(/```html\s*([\s\S]*?)```/i);
      if (htmlBlockMatch && htmlBlockMatch[1] && looksLikeCompleteHtmlDoc(htmlBlockMatch[1])) {
        return htmlBlockMatch[1].trim();
      }
      // Look for full <!DOCTYPE html> ... </html>
      const docTypeMatch = text.match(/<!DOCTYPE\s+html[\s\S]*?<\/html>/i);
      if (docTypeMatch && docTypeMatch[0] && docTypeMatch[0].length > 180) {
        return docTypeMatch[0].trim();
      }
      // Look for <html> ... </html>
      const htmlTagMatch = text.match(/<html[\s\S]*?<\/html>/i);
      if (htmlTagMatch && htmlTagMatch[0] && htmlTagMatch[0].length > 180) {
        return htmlTagMatch[0].trim();
      }
    }
  }
  return null;
}
