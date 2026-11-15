import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { loadKvFromPersistence, saveKvToPersistence } from './persistenceStore.ts';

const execPromise = promisify(exec);

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

export interface FirebaseServiceAccount {
  type?: string;
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  client_id?: string;
  token_uri?: string;
}

export interface FirebaseGlobalProfile {
  autoInject: boolean;
  webConfig: Partial<FirebaseWebConfig>;
  serviceAccount?: FirebaseServiceAccount | null;
  firebaseToken?: string;
  updatedAt: number;
}

export interface BlueprintCollectionSpec {
  path: string;
  entity: string;
  access?: 'owner' | 'authenticated' | 'public_read_auth_write' | 'admin_only' | 'role_based';
  ownerField?: string;
  description?: string;
}

export interface FirebaseBlueprint {
  appName?: string;
  entities: Record<
    string,
    {
      description?: string;
      requiredFields?: string[];
      allowedFields?: string[];
      schema?: Record<string, any>;
    }
  >;
  collections: BlueprintCollectionSpec[];
  authProviders?: string[];
  updatedAt?: number;
}

export interface RulesAuditResult {
  valid: boolean;
  securityScore: number;
  issues: string[];
  warnings: string[];
  collectionsCovered: string[];
}

const PROFILE_FILE = path.resolve(process.cwd(), '.nexus_firebase_profile.json');
const KV_PROFILE_KEY = 'nexus_firebase_global_profile';

export function sanitizeFirebaseSessionId(sessionId?: string): string {
  if (!sessionId) return '';
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function isPlaceholderValue(val?: string | null): boolean {
  if (!val) return true;
  const s = String(val).trim();
  if (!s) return true;
  return /^(REPLACE_WITH_|your-project-id|placeholder|demo-|example)/i.test(s);
}

export function parseFirebaseConfigInput(rawInput: string | Record<string, any>): Partial<FirebaseWebConfig> {
  if (!rawInput) return {};
  if (typeof rawInput === 'object') {
    const obj = rawInput as Record<string, any>;
    return {
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey.trim() : undefined,
      authDomain: typeof obj.authDomain === 'string' ? obj.authDomain.trim() : undefined,
      projectId: typeof obj.projectId === 'string' ? obj.projectId.trim() : undefined,
      storageBucket: typeof obj.storageBucket === 'string' ? obj.storageBucket.trim() : undefined,
      messagingSenderId: typeof obj.messagingSenderId === 'string' ? obj.messagingSenderId.trim() : undefined,
      appId: typeof obj.appId === 'string' ? obj.appId.trim() : undefined,
      measurementId: typeof obj.measurementId === 'string' ? obj.measurementId.trim() : undefined,
      firestoreDatabaseId: typeof obj.firestoreDatabaseId === 'string' ? obj.firestoreDatabaseId.trim() : undefined,
    };
  }

  const text = String(rawInput).trim();
  // Try pure JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return parseFirebaseConfigInput(parsed);
    }
  } catch {}

  // Extract key: "value" or key: 'value' from JS/TS firebaseConfig snippets
  const extract = (key: string): string | undefined => {
    const regex = new RegExp(`["']?${key}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, 'i');
    const m = text.match(regex);
    return m?.[1]?.trim();
  };

  const result: Partial<FirebaseWebConfig> = {
    apiKey: extract('apiKey'),
    authDomain: extract('authDomain'),
    projectId: extract('projectId'),
    storageBucket: extract('storageBucket'),
    messagingSenderId: extract('messagingSenderId'),
    appId: extract('appId'),
    measurementId: extract('measurementId'),
    firestoreDatabaseId: extract('firestoreDatabaseId'),
  };

  if (!result.authDomain && result.projectId) {
    result.authDomain = `${result.projectId}.firebaseapp.com`;
  }
  if (!result.storageBucket && result.projectId) {
    result.storageBucket = `${result.projectId}.firebasestorage.app`;
  }
  return result;
}

export async function loadFirebaseProfile(): Promise<FirebaseGlobalProfile> {
  try {
    const raw = await fs.readFile(PROFILE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        autoInject: parsed.autoInject !== false,
        webConfig: parsed.webConfig || {},
        serviceAccount: parsed.serviceAccount || null,
        firebaseToken: parsed.firebaseToken || '',
        updatedAt: parsed.updatedAt || Date.now(),
      };
    }
  } catch {}

  try {
    const remote = await loadKvFromPersistence<FirebaseGlobalProfile>(KV_PROFILE_KEY);
    if (remote && typeof remote === 'object') {
      await fs.writeFile(PROFILE_FILE, JSON.stringify(remote, null, 2), 'utf-8').catch(() => {});
      return {
        autoInject: remote.autoInject !== false,
        webConfig: remote.webConfig || {},
        serviceAccount: remote.serviceAccount || null,
        firebaseToken: remote.firebaseToken || '',
        updatedAt: remote.updatedAt || Date.now(),
      };
    }
  } catch {}

  return {
    autoInject: true,
    webConfig: {
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
      apiKey: process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY || '',
      authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
      storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.VITE_FIREBASE_APP_ID || '',
    },
    serviceAccount: null,
    firebaseToken: process.env.FIREBASE_TOKEN || '',
    updatedAt: Date.now(),
  };
}

export async function saveFirebaseProfile(partial: Partial<FirebaseGlobalProfile>): Promise<FirebaseGlobalProfile> {
  const current = await loadFirebaseProfile();
  const nextWebConfig: Partial<FirebaseWebConfig> = {
    ...(current.webConfig || {}),
    ...(partial.webConfig || {}),
  };
  if (nextWebConfig.projectId && !nextWebConfig.authDomain) {
    nextWebConfig.authDomain = `${nextWebConfig.projectId}.firebaseapp.com`;
  }
  if (nextWebConfig.projectId && !nextWebConfig.storageBucket) {
    nextWebConfig.storageBucket = `${nextWebConfig.projectId}.appspot.com`;
  }

  const next: FirebaseGlobalProfile = {
    autoInject: partial.autoInject !== undefined ? Boolean(partial.autoInject) : current.autoInject,
    webConfig: nextWebConfig,
    serviceAccount:
      partial.serviceAccount !== undefined ? partial.serviceAccount : current.serviceAccount || null,
    firebaseToken:
      partial.firebaseToken !== undefined ? partial.firebaseToken : current.firebaseToken || '',
    updatedAt: Date.now(),
  };

  await fs.writeFile(PROFILE_FILE, JSON.stringify(next, null, 2), 'utf-8');
  await saveKvToPersistence(KV_PROFILE_KEY, next).catch(() => {});
  return next;
}

export async function resolveFirebaseTargetDir(sessionId?: string, explicitDir?: string): Promise<{
  targetDir: string;
  relativeRoot: string;
  kind: 'workspace' | 'static-project' | 'host';
}> {
  if (explicitDir && explicitDir !== '.' && explicitDir !== '/') {
    const clean = explicitDir.replace(/^[/\\]+/, '');
    const abs = path.resolve(process.cwd(), clean);
    if (abs.startsWith(process.cwd())) {
      await fs.mkdir(abs, { recursive: true });
      return {
        targetDir: abs,
        relativeRoot: path.relative(process.cwd(), abs).replace(/\\/g, '/'),
        kind: clean.startsWith('workspaces') ? 'workspace' : clean.startsWith('projects') ? 'static-project' : 'host',
      };
    }
  }

  const safeId = sanitizeFirebaseSessionId(sessionId);
  if (safeId) {
    const wsDir = path.join(process.cwd(), 'workspaces', safeId);
    const wsExists = await fs.access(wsDir).then(() => true).catch(() => false);
    if (wsExists) {
      return { targetDir: wsDir, relativeRoot: `workspaces/${safeId}`, kind: 'workspace' };
    }

    const projDir = path.join(process.cwd(), 'projects', safeId);
    const projExists = await fs.access(path.join(projDir, 'index.html')).then(() => true).catch(() => false);
    if (projExists) {
      return { targetDir: projDir, relativeRoot: `projects/${safeId}`, kind: 'static-project' };
    }

    // Default modular workspace for new app sessions
    await fs.mkdir(wsDir, { recursive: true });
    return { targetDir: wsDir, relativeRoot: `workspaces/${safeId}`, kind: 'workspace' };
  }

  return { targetDir: process.cwd(), relativeRoot: '', kind: 'host' };
}

export function generateRulesFromBlueprint(blueprint?: FirebaseBlueprint | null): string {
  const collections = Array.isArray(blueprint?.collections) ? blueprint!.collections : [];

  const helperBlock = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ===============================================================
    // Helper Functions (Auto-generated by Nexus Firebase Engine)
    // ===============================================================
    function isAuthenticated() {
      return request.auth != null;
    }

    function isOwner(userId) {
      return isAuthenticated() && request.auth.uid == userId;
    }

    function isDocOwner(ownerField) {
      return isAuthenticated() && resource != null && resource.data[ownerField] == request.auth.uid;
    }

    function isNewDocOwner(ownerField) {
      return isAuthenticated() && request.resource.data[ownerField] == request.auth.uid;
    }

    function isAdmin() {
      return isAuthenticated() && (
        (exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin') ||
        (request.auth.token.email_verified == true && request.auth.token.admin == true)
      );
    }

    function hasRequiredFields(fields) {
      return request.resource.data.keys().hasAll(fields);
    }

    function hasOnlyAllowedFields(fields) {
      return request.resource.data.keys().hasOnly(fields);
    }

    function isValidId(id) {
      return id is string && id.size() >= 1 && id.size() <= 128 && id.matches('^[a-zA-Z0-9_\\\\-]+$');
    }`;

  const collectionRules: string[] = [];
  const hasUsersRule = collections.some((c) => /^\/?users(\/|$)/i.test(c.path));

  if (!hasUsersRule) {
    collectionRules.push(`
    match /users/{userId} {
      allow read: if isOwner(userId) || isAdmin();
      allow create: if isOwner(userId) && (!('role' in request.resource.data) || request.resource.data.role == 'user');
      allow update: if (isOwner(userId) && (!('role' in request.resource.data) || request.resource.data.role == resource.data.role)) || isAdmin();
      allow delete: if isAdmin();
    }`);
  }

  for (const col of collections) {
    const cleanPath = String(col.path || '').replace(/^\/+/, '');
    if (!cleanPath) continue;
    const access = col.access || 'owner';
    const ownerField = col.ownerField || 'userId';
    const entityDef = blueprint?.entities?.[col.entity];
    const reqFields = Array.isArray(entityDef?.requiredFields) && entityDef!.requiredFields!.length > 0
      ? ` && hasRequiredFields(${JSON.stringify(entityDef!.requiredFields)})`
      : '';
    const allowedFields = Array.isArray(entityDef?.allowedFields) && entityDef!.allowedFields!.length > 0
      ? ` && hasOnlyAllowedFields(${JSON.stringify(entityDef!.allowedFields)})`
      : '';
    const validationExpr = `${reqFields}${allowedFields}`;

    const matchPath = cleanPath.includes('{') ? cleanPath : `${cleanPath}/{docId}`;

    if (access === 'admin_only') {
      collectionRules.push(`
    match /${matchPath} {
      allow read, write: if isAdmin()${validationExpr};
    }`);
    } else if (access === 'public_read_auth_write') {
      collectionRules.push(`
    match /${matchPath} {
      allow read: if true;
      allow create: if isAuthenticated()${validationExpr};
      allow update, delete: if isDocOwner('${ownerField}') || isAdmin();
    }`);
    } else if (access === 'authenticated') {
      collectionRules.push(`
    match /${matchPath} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()${validationExpr};
      allow update, delete: if isAuthenticated()${validationExpr};
    }`);
    } else if (access === 'role_based') {
      collectionRules.push(`
    match /${matchPath} {
      allow read: if isAuthenticated() && (isDocOwner('${ownerField}') || isAdmin());
      allow create: if isNewDocOwner('${ownerField}')${validationExpr};
      allow update: if (isDocOwner('${ownerField}') || isAdmin())${validationExpr};
      allow delete: if isDocOwner('${ownerField}') || isAdmin();
    }`);
    } else {
      // Strict owner-only default
      const isUsersRoot = /^users\/\{/i.test(matchPath);
      if (isUsersRoot) {
        collectionRules.push(`
    match /${matchPath} {
      allow read: if isOwner(userId) || isAdmin();
      allow create: if isOwner(userId)${validationExpr};
      allow update: if (isOwner(userId) || isAdmin())${validationExpr};
      allow delete: if isAdmin();
    }`);
      } else {
        collectionRules.push(`
    match /${matchPath} {
      allow read: if isDocOwner('${ownerField}') || isAdmin();
      allow create: if isNewDocOwner('${ownerField}')${validationExpr};
      allow update: if (isDocOwner('${ownerField}') && isNewDocOwner('${ownerField}')${validationExpr}) || isAdmin();
      allow delete: if isDocOwner('${ownerField}') || isAdmin();
    }`);
      }
    }
  }

  if (collections.length === 0) {
    collectionRules.push(`
    match /items/{itemId} {
      allow read: if isDocOwner('userId') || isAdmin();
      allow create: if isNewDocOwner('userId');
      allow update: if (isDocOwner('userId') && isNewDocOwner('userId')) || isAdmin();
      allow delete: if isDocOwner('userId') || isAdmin();
    }`);
  }

  return `${helperBlock}
${collectionRules.join('\n')}

    // Default deny for any undeclared collection
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;
}

export function auditFirestoreRules(rulesContent: string, blueprint?: FirebaseBlueprint | null): RulesAuditResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  if (!rulesContent || !rulesContent.trim()) {
    return { valid: false, securityScore: 0, issues: ['firestore.rules is empty.'], warnings: [], collectionsCovered: [] };
  }

  if (!/rules_version\s*=\s*['"]2['"]\s*;/.test(rulesContent)) {
    issues.push("Missing `rules_version = '2';` header.");
    score -= 25;
  }
  if (!/service\s+cloud\.firestore\s*\{/.test(rulesContent)) {
    issues.push('Missing `service cloud.firestore {` declaration.');
    score -= 30;
  }
  const opens = (rulesContent.match(/\{/g) || []).length;
  const closes = (rulesContent.match(/\}/g) || []).length;
  if (opens !== closes) {
    issues.push(`Unbalanced curly braces (${opens} opening vs ${closes} closing).`);
    score -= 40;
  }

  if (/allow\s+(?:read\s*,\s*write|write)\s*:\s*if\s+true\s*;/.test(rulesContent)) {
    warnings.push('Insecure wildcard `allow write: if true` detected. Always require authentication or ownership checks.');
    score -= 35;
  }

  if (/match\s+\/\{document=\*\*\}\s*\{[\s\S]*?allow\s+read\s*,\s*write\s*:\s*if\s+request\.auth\s*!=\s*null/.test(rulesContent)) {
    warnings.push('Overly broad fallback `match /{document=**}` allows any signed-in user to read/write everything. Prefer explicit collection rules + default deny (`if false`).');
    score -= 15;
  }

  if (!/allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;/.test(rulesContent)) {
    warnings.push('Consider adding an explicit default-deny block `match /{document=**} { allow read, write: if false; }`.');
    score -= 5;
  }

  const matches = Array.from(rulesContent.matchAll(/match\s+\/([a-zA-Z0-9_{}/-]+)/g)).map((m) => m[1]);
  if (blueprint?.collections?.length) {
    for (const col of blueprint.collections) {
      const top = String(col.path || '').replace(/^\/+/, '').split('/')[0];
      if (top && !matches.some((m) => m.startsWith(top))) {
        warnings.push(`Blueprint collection "${col.path}" has no explicit match block in firestore.rules.`);
        score -= 10;
      }
    }
  }

  return {
    valid: issues.length === 0,
    securityScore: Math.max(0, Math.min(100, score)),
    issues,
    warnings,
    collectionsCovered: matches.filter((m) => m !== '{document=**}'),
  };
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function getGoogleAccessTokenFromServiceAccount(sa: FirebaseServiceAccount): Promise<string> {
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error('Service Account JSON is missing client_email or private_key.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key.replace(/\\n/g, '\n')));
  const assertion = `${signingInput}.${signature}`;

  const tokenRes = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new Error(tokenJson?.error_description || tokenJson?.error || `OAuth2 token request failed (${tokenRes.status})`);
  }
  return tokenJson.access_token;
}

export async function deployRulesToFirebaseCloud(
  projectId: string,
  rulesContent: string
): Promise<{
  success: boolean;
  validatedLocally: boolean;
  deployedRemotely: boolean;
  method: 'service-account-rest' | 'firebase-cli-token' | 'local-audit-only';
  projectId?: string;
  rulesetName?: string;
  audit: RulesAuditResult;
  message: string;
  error?: string;
}> {
  const audit = auditFirestoreRules(rulesContent);
  if (!audit.valid) {
    return {
      success: false,
      validatedLocally: false,
      deployedRemotely: false,
      method: 'local-audit-only',
      projectId,
      audit,
      message: 'firestore.rules failed syntax validation.',
      error: audit.issues.join(' | '),
    };
  }

  const profile = await loadFirebaseProfile();
  const effectiveProjectId =
    (!isPlaceholderValue(projectId) ? projectId : '') ||
    (!isPlaceholderValue(profile.webConfig?.projectId) ? profile.webConfig?.projectId : '') ||
    profile.serviceAccount?.project_id ||
    '';

  // 1. Try instant REST API deployment via Service Account JSON
  if (profile.serviceAccount?.client_email && profile.serviceAccount?.private_key && effectiveProjectId) {
    try {
      const accessToken = await getGoogleAccessTokenFromServiceAccount(profile.serviceAccount);

      // Step A: Create & compile-validate ruleset via Firebase Rules API
      const createRes = await fetch(
        `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(effectiveProjectId)}/rulesets`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            source: {
              files: [{ name: 'firestore.rules', content: rulesContent }],
            },
          }),
          signal: AbortSignal.timeout(12000),
        }
      );
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData?.name) {
        throw new Error(createData?.error?.message || `Ruleset creation failed (${createRes.status})`);
      }

      // Step B: Release ruleset to cloud.firestore
      const releaseName = `projects/${effectiveProjectId}/releases/cloud.firestore`;
      const releaseRes = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          release: {
            name: releaseName,
            rulesetName: createData.name,
          },
        }),
        signal: AbortSignal.timeout(12000),
      });
      const releaseData = await releaseRes.json().catch(() => ({}));
      if (!releaseRes.ok) {
        // Fallback: create release if it doesn't exist yet
        const postRelease = await fetch(
          `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(effectiveProjectId)}/releases`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: releaseName,
              rulesetName: createData.name,
            }),
            signal: AbortSignal.timeout(12000),
          }
        );
        if (!postRelease.ok) {
          const postErr = await postRelease.json().catch(() => ({}));
          throw new Error(postErr?.error?.message || releaseData?.error?.message || `Release failed (${releaseRes.status})`);
        }
      }

      return {
        success: true,
        validatedLocally: true,
        deployedRemotely: true,
        method: 'service-account-rest',
        projectId: effectiveProjectId,
        rulesetName: createData.name,
        audit,
        message: `firestore.rules validated and deployed live to Firebase project "${effectiveProjectId}"!`,
      };
    } catch (restErr: any) {
      return {
        success: false,
        validatedLocally: true,
        deployedRemotely: false,
        method: 'service-account-rest',
        projectId: effectiveProjectId,
        audit,
        message: `Local rules valid (score ${audit.securityScore}/100), but remote Firebase Rules API deploy failed.`,
        error: restErr.message,
      };
    }
  }

  // 2. Try FIREBASE_TOKEN + Firebase CLI if token configured
  const token = profile.firebaseToken || process.env.FIREBASE_TOKEN || '';
  if (token && effectiveProjectId) {
    try {
      const { stdout } = await execPromise(
        `npx --yes firebase-tools deploy --only firestore:rules --project "${effectiveProjectId}" --token "${token}"`,
        { cwd: process.cwd(), timeout: 45000 }
      );
      return {
        success: true,
        validatedLocally: true,
        deployedRemotely: true,
        method: 'firebase-cli-token',
        projectId: effectiveProjectId,
        audit,
        message: `firestore.rules deployed via Firebase CLI to "${effectiveProjectId}": ${stdout.trim().slice(0, 180)}`,
      };
    } catch (cliErr: any) {
      return {
        success: false,
        validatedLocally: true,
        deployedRemotely: false,
        method: 'firebase-cli-token',
        projectId: effectiveProjectId,
        audit,
        message: `Local rules valid, but Firebase CLI deploy failed.`,
        error: cliErr.message,
      };
    }
  }

  return {
    success: true,
    validatedLocally: true,
    deployedRemotely: false,
    method: 'local-audit-only',
    projectId: effectiveProjectId || undefined,
    audit,
    message: `firestore.rules syntax & security audited locally (Security Score: ${audit.securityScore}/100). Add a Service Account JSON or FIREBASE_TOKEN in Firebase Modal for 1-click live cloud rules deployment.`,
  };
}

export async function testFirebaseAdminConnection(): Promise<{
  ok: boolean;
  projectId?: string;
  activeRelease?: string;
  message: string;
}> {
  const profile = await loadFirebaseProfile();
  const sa = profile.serviceAccount;
  const projectId = sa?.project_id || profile.webConfig?.projectId || '';
  if (!sa?.client_email || !sa?.private_key) {
    return {
      ok: false,
      projectId: projectId || undefined,
      message: 'No Firebase Service Account JSON configured yet.',
    };
  }
  try {
    const token = await getGoogleAccessTokenFromServiceAccount(sa);
    const res = await fetch(
      `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/releases/cloud.firestore`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        ok: true,
        projectId,
        activeRelease: data?.rulesetName || 'connected',
        message: `Connected to Firebase project "${projectId}" (Firestore Rules API active).`,
      };
    }
    if (res.status === 404) {
      return {
        ok: true,
        projectId,
        message: `OAuth2 Service Account verified for "${projectId}" (ready to publish initial firestore.rules release).`,
      };
    }
    return {
      ok: false,
      projectId,
      message: data?.error?.message || `Firebase Rules API returned HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      projectId,
      message: err?.message || 'Connection test failed',
    };
  }
}

export function buildFirebaseSdkModule(fbConfig: FirebaseWebConfig): string {
  return `import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDocFromServer,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { getStorage } from 'firebase/storage';

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || ${JSON.stringify(fbConfig.apiKey)},
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || ${JSON.stringify(fbConfig.authDomain)},
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || ${JSON.stringify(fbConfig.projectId)},
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || ${JSON.stringify(fbConfig.storageBucket)},
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || ${JSON.stringify(fbConfig.messagingSenderId)},
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ${JSON.stringify(fbConfig.appId)},${
    fbConfig.firestoreDatabaseId
      ? `\n  firestoreDatabaseId: import.meta.env.VITE_FIREBASE_DATABASE_ID || ${JSON.stringify(fbConfig.firestoreDatabaseId)},`
      : ''
  }
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.includes('REPLACE_WITH_') &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.includes('your-project-id')
);

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    }${fbConfig.firestoreDatabaseId ? `, ${JSON.stringify(fbConfig.firestoreDatabaseId)}` : ''}
  );
} catch {
  firestoreInstance = ${
    fbConfig.firestoreDatabaseId
      ? `getFirestore(app, ${JSON.stringify(fbConfig.firestoreDatabaseId)})`
      : `getFirestore(app)`
  };
}

export const db = firestoreInstance;
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export async function signOutUser() {
  return signOut(auth);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  if (!isFirebaseConfigured) return false;
  try {
    await getDocFromServer(doc(db, '_nexus_health', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Firebase client is offline or misconfigured.');
      return false;
    }
    return true;
  }
}
`;
}

export function buildFirebaseProviderModule(): string {
  return `import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  auth,
  isFirebaseConfigured,
  signInWithGoogle,
  signOutUser,
  testFirestoreConnection,
} from '../lib/firebase';

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  isConfigured: boolean;
  connectionOk: boolean;
  authError: string | null;
  signIn: () => Promise<User | null>;
  logout: () => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue>({
  user: null,
  authReady: false,
  isConfigured: false,
  connectionOk: false,
  authError: null,
  signIn: async () => null,
  logout: async () => {},
});

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [connectionOk, setConnectionOk] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void testFirestoreConnection().then(setConnectionOk).catch(() => setConnectionOk(false));
    if (!isFirebaseConfigured) {
      setAuthReady(true);
      return;
    }
    const unsub = onAuthStateChanged(
      auth,
      (nextUser) => {
        setUser(nextUser);
        setAuthReady(true);
      },
      (err) => {
        setAuthError(err?.message || 'Auth listener failed');
        setAuthReady(true);
      }
    );
    return () => unsub();
  }, []);

  const signIn = async () => {
    setAuthError(null);
    try {
      const res = await signInWithGoogle();
      return res.user;
    } catch (err: any) {
      setAuthError(err?.message || 'Google Sign-In failed');
      return null;
    }
  };

  const logout = async () => {
    setAuthError(null);
    await signOutUser();
  };

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        isConfigured: isFirebaseConfigured,
        connectionOk,
        authError,
        signIn,
        logout,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase() {
  return useContext(FirebaseContext);
}
`;
}

function toCamelCase(input: string): string {
  return String(input || '')
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase()) || 'item';
}

function toPascalCase(input: string): string {
  const c = toCamelCase(input);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function pluralizeName(singular: string): string {
  const lower = singular.toLowerCase();
  if (lower.endsWith('s')) return lower;
  if (lower.endsWith('y') && !/[aeiou]y$/i.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

function inferCollectionAccess(entityName: string, fieldNames: string[]): {
  access: BlueprintCollectionSpec['access'];
  ownerField: string;
} {
  const lower = entityName.toLowerCase();
  const hasOwnerField = fieldNames.find((f) => /^(userId|ownerId|authorId|uid|customerId|createdBy)$/i.test(f));
  const ownerField = hasOwnerField || 'userId';

  if (/(admin|audit|config|setting|role)/i.test(lower) && !/user/i.test(lower)) {
    return { access: 'authenticated', ownerField };
  }
  if (/(product|catalog|item|course|post|article|blog|service|menu|event|project|listing|property|template|plan|faq|testimonial|category|review)/i.test(lower)) {
    return { access: 'public_read_auth_write', ownerField };
  }
  if (/(message|chat|comment|thread|channel|room)/i.test(lower)) {
    return { access: 'authenticated', ownerField };
  }
  return { access: 'owner', ownerField };
}

export async function inferBlueprintFromWorkspace(
  targetDir: string,
  appNameHint?: string
): Promise<FirebaseBlueprint> {
  const candidateFiles = [
    path.join(targetDir, 'src/types.ts'),
    path.join(targetDir, 'src/types/index.ts'),
    path.join(targetDir, 'src/data/seed.ts'),
    path.join(targetDir, 'server/routes.ts'),
  ];

  const entities: FirebaseBlueprint['entities'] = {};
  const collections: BlueprintCollectionSpec[] = [];
  const seenCollectionPaths = new Set<string>();

  for (const fp of candidateFiles) {
    const raw = await fs.readFile(fp, 'utf-8').catch(() => '');
    if (!raw.trim()) continue;

    // Parse exported TypeScript interfaces / object types
    const ifaceRegex = /export\s+(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\s*(?:=\s*)?\{([\s\S]*?)\n\}/g;
    let match: RegExpExecArray | null;
    while ((match = ifaceRegex.exec(raw)) !== null) {
      const entityName = match[1];
      if (/(Props|State|Context|Tab|Filter|Sort|Option|Config|Response|Payload|Params)$/i.test(entityName)) {
        continue;
      }
      const body = match[2] || '';
      const requiredFields: string[] = [];
      const allowedFields: string[] = [];
      const schema: Record<string, any> = {};

      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('*')) continue;
        const propMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\?)?\s*:\s*([^;]+)/);
        if (!propMatch) continue;
        const propName = propMatch[1];
        const isOptional = Boolean(propMatch[2]);
        const propTypeRaw = propMatch[3].trim();

        allowedFields.push(propName);
        if (!isOptional && propName !== 'id') {
          requiredFields.push(propName);
        }
        schema[propName] = {
          type: /\[\]|Array</i.test(propTypeRaw)
            ? 'array'
            : /\bnumber\b/i.test(propTypeRaw)
              ? 'number'
              : /\bboolean\b/i.test(propTypeRaw)
                ? 'boolean'
                : 'string',
        };
      }

      if (allowedFields.length === 0) continue;

      if (!allowedFields.includes('userId') && !allowedFields.includes('ownerId') && !/^User/i.test(entityName)) {
        allowedFields.push('userId');
      }
      if (!allowedFields.includes('createdAt')) allowedFields.push('createdAt');
      if (!allowedFields.includes('updatedAt')) allowedFields.push('updatedAt');

      entities[entityName] = {
        description: `Domain model for ${entityName} inferred from workspace types`,
        requiredFields: requiredFields.slice(0, 6),
        allowedFields,
        schema,
      };

      const isUserEntity = /^User(Profile)?$/i.test(entityName);
      const colKey = isUserEntity ? 'users' : pluralizeName(toCamelCase(entityName));
      const paramName = isUserEntity ? 'userId' : `${toCamelCase(entityName)}Id`;
      const colPath = `/${colKey}/{${paramName}}`;

      if (!seenCollectionPaths.has(colPath)) {
        seenCollectionPaths.add(colPath);
        const inferred = inferCollectionAccess(entityName, allowedFields);
        collections.push({
          path: colPath,
          entity: entityName,
          access: isUserEntity ? 'owner' : inferred.access,
          ownerField: isUserEntity ? 'uid' : inferred.ownerField,
          description: `Firestore collection for ${entityName} records`,
        });
      }
    }

    // Also inspect Express REST routes like app.get('/api/orders', ...) if no interface matched
    const routeRegex = /\.(?:get|post|put|patch|delete)\(\s*['"]\/(?:api\/)?([a-zA-Z][a-zA-Z0-9_-]{1,30})(?:\/:[^'"]+)?['"]/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = routeRegex.exec(raw)) !== null) {
      const routeCol = rMatch[1].toLowerCase();
      if (['health', 'status', 'auth', 'login', 'logout'].includes(routeCol)) continue;
      const singular = routeCol.endsWith('ies')
        ? `${routeCol.slice(0, -3)}y`
        : routeCol.endsWith('s')
          ? routeCol.slice(0, -1)
          : routeCol;
      const entityName = toPascalCase(singular);
      const colPath = `/${routeCol}/{${toCamelCase(singular)}Id}`;
      if (!seenCollectionPaths.has(colPath)) {
        seenCollectionPaths.add(colPath);
        if (!entities[entityName]) {
          entities[entityName] = {
            description: `API-backed ${entityName} entity`,
            requiredFields: ['userId'],
            allowedFields: ['id', 'userId', 'title', 'name', 'status', 'data', 'createdAt', 'updatedAt'],
          };
        }
        const inferred = inferCollectionAccess(entityName, entities[entityName].allowedFields || []);
        collections.push({
          path: colPath,
          entity: entityName,
          access: inferred.access,
          ownerField: inferred.ownerField,
          description: `Firestore collection synced with /api/${routeCol}`,
        });
      }
    }
  }

  // Always ensure User entity & /users/{userId} exist
  if (!entities.User) {
    entities.User = {
      description: 'Authenticated user profile',
      requiredFields: ['uid', 'email'],
      allowedFields: ['uid', 'email', 'displayName', 'photoURL', 'role', 'createdAt', 'updatedAt'],
    };
  }
  if (!collections.some((c) => /^\/?users(\/|$)/i.test(c.path))) {
    collections.unshift({
      path: '/users/{userId}',
      entity: 'User',
      access: 'owner',
      ownerField: 'uid',
      description: 'Private user profiles',
    });
  }

  if (collections.length <= 1 && !entities.WorkspaceRecord) {
    entities.WorkspaceRecord = {
      description: 'Primary application record',
      requiredFields: ['title', 'userId'],
      allowedFields: ['id', 'title', 'description', 'category', 'status', 'payload', 'userId', 'createdAt', 'updatedAt'],
    };
    collections.push({
      path: '/records/{recordId}',
      entity: 'WorkspaceRecord',
      access: 'owner',
      ownerField: 'userId',
      description: 'Persistent application records',
    });
  }

  return {
    appName: appNameHint || 'Nexus Firebase App',
    entities,
    collections,
    authProviders: ['google', 'email_password'],
    updatedAt: Date.now(),
  };
}

export function buildFirebaseBackendServiceModule(blueprint: FirebaseBlueprint): string {
  const collections = Array.isArray(blueprint.collections) ? blueprint.collections : [];
  const entities = blueprint.entities || {};

  const entityInterfaces = Object.entries(entities)
    .map(([name, def]) => {
      const schema = def?.schema || {};
      const fields = Array.from(new Set([...(def?.allowedFields || []), ...(def?.requiredFields || [])]));
      const props = fields
        .filter((f) => f !== 'id')
        .map((f) => {
          const t = schema?.[f]?.type === 'number'
            ? 'number'
            : schema?.[f]?.type === 'boolean'
              ? 'boolean'
              : schema?.[f]?.type === 'array'
                ? 'any[]'
                : 'string';
          const opt = def?.requiredFields?.includes(f) ? '' : '?';
          return `  ${f}${opt}: ${t};`;
        });
      return `export interface ${name}Record {\n  id?: string;\n${props.join('\n') || '  [key: string]: any;'}\n  [key: string]: any;\n}`;
    })
    .join('\n\n');

  const collectionEntries = collections
    .map((col) => {
      const cleanPath = String(col.path || '').replace(/^\/+/, '');
      const rootCollection = cleanPath.split('/')[0] || 'items';
      const entityName = toPascalCase(col.entity || rootCollection);
      const recordType = entities[col.entity] ? `${col.entity}Record` : 'Record<string, any>';
      const ownerField = col.ownerField || 'userId';
      const fnSuffix = toPascalCase(rootCollection);
      const singularSuffix = toPascalCase(
        rootCollection.endsWith('ies')
          ? `${rootCollection.slice(0, -3)}y`
          : rootCollection.endsWith('s')
            ? rootCollection.slice(0, -1)
            : rootCollection
      );

      if (rootCollection === 'users') {
        return `  // Collection: /users/{userId}
  users: {
    path: 'users',
    getById: (uid: string) => getDocument<${recordType}>('users', uid),
    upsert: (uid: string, data: Partial<${recordType}>) => upsertDocument<${recordType}>('users', uid, data, '${ownerField}'),
  },`;
      }

      return `  // Collection: ${col.path} (${col.access || 'owner'})
  ${toCamelCase(rootCollection)}: {
    path: '${rootCollection}',
    subscribe: (
      onData: (rows: Array<${recordType} & { id: string }>) => void,
      options?: { ownerOnly?: boolean; limitCount?: number; onError?: (err: Error) => void }
    ) => subscribeToCollection<${recordType}>('${rootCollection}', onData, { ...options, ownerField: '${ownerField}' }),
    list: (ownerOnly = ${col.access === 'owner'}) =>
      listCollectionDocs<${recordType}>('${rootCollection}', { ownerOnly, ownerField: '${ownerField}' }),
    getById: (id: string) => getDocument<${recordType}>('${rootCollection}', id),
    create: (data: Omit<${recordType}, 'id'>) =>
      createDocument<${recordType}>('${rootCollection}', data, '${ownerField}'),
    update: (id: string, patch: Partial<${recordType}>) =>
      updateDocument<${recordType}>('${rootCollection}', id, patch),
    remove: (id: string) => deleteDocument('${rootCollection}', id),
  },
  // Named convenience aliases for ${entityName}
  list${fnSuffix}: (ownerOnly = ${col.access === 'owner'}) =>
    listCollectionDocs<${recordType}>('${rootCollection}', { ownerOnly, ownerField: '${ownerField}' }),
  subscribe${fnSuffix}: (
    onData: (rows: Array<${recordType} & { id: string }>) => void,
    options?: { ownerOnly?: boolean; limitCount?: number; onError?: (err: Error) => void }
  ) => subscribeToCollection<${recordType}>('${rootCollection}', onData, { ...options, ownerField: '${ownerField}' }),
  create${singularSuffix}: (data: Omit<${recordType}, 'id'>) =>
    createDocument<${recordType}>('${rootCollection}', data, '${ownerField}'),
  update${singularSuffix}: (id: string, patch: Partial<${recordType}>) =>
    updateDocument<${recordType}>('${rootCollection}', id, patch),
  delete${singularSuffix}: (id: string) =>
    deleteDocument('${rootCollection}', id),`;
    })
    .join('\n\n');

  return `// Auto-generated Code-Matched Firebase Backend Service (synced with firebase-blueprint.json)
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import {
  auth,
  db,
  handleFirestoreError,
  isFirebaseConfigured,
  OperationType,
} from '../lib/firebase';

${entityInterfaces}

const LOCAL_EVENT_NAME = 'nexus-firebase-local-update';

function readLocalCollection<T = Record<string, any>>(colPath: string): Array<T & { id: string }> {
  try {
    const raw = localStorage.getItem(\`nexus_fb_\${colPath}\`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalCollection<T = Record<string, any>>(colPath: string, rows: Array<T & { id: string }>): void {
  try {
    localStorage.setItem(\`nexus_fb_\${colPath}\`, JSON.stringify(rows));
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT_NAME, { detail: { colPath } }));
  } catch {}
}

export async function syncUserProfile(user: User | null): Promise<void> {
  if (!user) return;
  const payload = {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || user.email?.split('@')[0] || 'Member',
    photoURL: user.photoURL || '',
    role: 'user',
    updatedAt: new Date().toISOString(),
  };
  if (!isFirebaseConfigured) {
    const rows = readLocalCollection('users');
    const next = [...rows.filter((r) => r.id !== user.uid), { id: user.uid, ...payload }];
    writeLocalCollection('users', next);
    return;
  }
  try {
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    await setDoc(
      ref,
      {
        ...payload,
        ...(snap.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, \`users/\${user.uid}\`);
  }
}

export async function listCollectionDocs<T = Record<string, any>>(
  colPath: string,
  options: { ownerOnly?: boolean; ownerField?: string; limitCount?: number } = {}
): Promise<Array<T & { id: string }>> {
  if (!isFirebaseConfigured) {
    return readLocalCollection<T>(colPath);
  }
  const ownerField = options.ownerField || 'userId';
  const uid = auth.currentUser?.uid;
  if (options.ownerOnly && !uid) return [];

  try {
    const constraints: QueryConstraint[] = [];
    if (options.ownerOnly && uid) {
      constraints.push(where(ownerField, '==', uid));
    }
    if (options.limitCount) {
      constraints.push(limit(options.limitCount));
    }
    const q = constraints.length > 0 ? query(collection(db, colPath), ...constraints) : collection(db, colPath);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colPath);
  }
}

export function subscribeToCollection<T = Record<string, any>>(
  colPath: string,
  onData: (rows: Array<T & { id: string }>) => void,
  options: {
    ownerOnly?: boolean;
    ownerField?: string;
    limitCount?: number;
    orderByField?: string;
    onError?: (err: Error) => void;
  } = {}
): () => void {
  if (!isFirebaseConfigured) {
    onData(readLocalCollection<T>(colPath));
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent)?.detail;
      if (!detail?.colPath || detail.colPath === colPath) {
        onData(readLocalCollection<T>(colPath));
      }
    };
    window.addEventListener(LOCAL_EVENT_NAME, handler);
    return () => window.removeEventListener(LOCAL_EVENT_NAME, handler);
  }

  const ownerField = options.ownerField || 'userId';
  const uid = auth.currentUser?.uid;
  if (options.ownerOnly && !uid) {
    onData([]);
    return () => {};
  }

  const constraints: QueryConstraint[] = [];
  if (options.ownerOnly && uid) {
    constraints.push(where(ownerField, '==', uid));
  }
  if (options.orderByField) {
    constraints.push(orderBy(options.orderByField, 'desc'));
  }
  if (options.limitCount) {
    constraints.push(limit(options.limitCount));
  }
  const q = constraints.length > 0 ? query(collection(db, colPath), ...constraints) : collection(db, colPath);

  return onSnapshot(
    q,
    (snapshot) => {
      const rows = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
      onData(rows);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrappedErr: any) {
        options.onError?.(wrappedErr);
      }
    }
  );
}

export async function getDocument<T = Record<string, any>>(
  colPath: string,
  id: string
): Promise<(T & { id: string }) | null> {
  if (!isFirebaseConfigured) {
    return readLocalCollection<T>(colPath).find((r) => r.id === id) || null;
  }
  try {
    const snap = await getDoc(doc(db, colPath, id));
    return snap.exists() ? ({ id: snap.id, ...(snap.data() as T) }) : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, \`\${colPath}/\${id}\`);
  }
}

export async function createDocument<T = Record<string, any>>(
  colPath: string,
  data: Omit<T, 'id'>,
  ownerField = 'userId'
): Promise<T & { id: string }> {
  const uid = auth.currentUser?.uid || 'local-user';
  const basePayload: Record<string, any> = {
    ...(data as Record<string, any>),
    [ownerField]: (data as Record<string, any>)[ownerField] || uid,
  };

  if (!isFirebaseConfigured) {
    const id = \`local_\${Date.now()}_\${Math.random().toString(36).slice(2, 7)}\`;
    const record = {
      id,
      ...basePayload,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as T & { id: string };
    const rows = readLocalCollection<T>(colPath);
    writeLocalCollection(colPath, [record, ...rows]);
    return record;
  }

  try {
    const docRef = await addDoc(collection(db, colPath), {
      ...basePayload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { id: docRef.id, ...basePayload } as unknown as T & { id: string };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, colPath);
  }
}

export async function upsertDocument<T = Record<string, any>>(
  colPath: string,
  id: string,
  data: Partial<T>,
  ownerField = 'userId'
): Promise<void> {
  const uid = auth.currentUser?.uid || 'local-user';
  const payload: Record<string, any> = {
    ...(data as Record<string, any>),
    [ownerField]: (data as Record<string, any>)[ownerField] || uid,
  };
  if (!isFirebaseConfigured) {
    const rows = readLocalCollection<T>(colPath);
    const existing = rows.find((r) => r.id === id);
    const updated = {
      ...(existing || {}),
      id,
      ...payload,
      updatedAt: new Date().toISOString(),
    } as unknown as T & { id: string };
    writeLocalCollection(colPath, [updated, ...rows.filter((r) => r.id !== id)]);
    return;
  }
  try {
    await setDoc(
      doc(db, colPath, id),
      { ...payload, updatedAt: serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, \`\${colPath}/\${id}\`);
  }
}

export async function updateDocument<T = Record<string, any>>(
  colPath: string,
  id: string,
  patch: Partial<T>
): Promise<void> {
  if (!isFirebaseConfigured) {
    const rows = readLocalCollection<T>(colPath);
    const next = rows.map((r) =>
      r.id === id ? { ...r, ...(patch as Record<string, any>), updatedAt: new Date().toISOString() } : r
    );
    writeLocalCollection(colPath, next);
    return;
  }
  try {
    await updateDoc(doc(db, colPath, id), {
      ...(patch as Record<string, any>),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, \`\${colPath}/\${id}\`);
  }
}

export async function deleteDocument(colPath: string, id: string): Promise<void> {
  if (!isFirebaseConfigured) {
    const rows = readLocalCollection(colPath).filter((r) => r.id !== id);
    writeLocalCollection(colPath, rows);
    return;
  }
  try {
    await deleteDoc(doc(db, colPath, id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, \`\${colPath}/\${id}\`);
  }
}

export const firebaseBackend = {
  isLive: isFirebaseConfigured,
  syncUserProfile,
${collectionEntries}
};

export default firebaseBackend;
`;
}

export function buildServerFirebaseAdminHelper(
  fbConfig: FirebaseWebConfig,
  blueprint: FirebaseBlueprint
): string {
  const collectionNames = (blueprint.collections || [])
    .map((c) => String(c.path || '').replace(/^\/+/, '').split('/')[0])
    .filter(Boolean);

  return `// Auto-generated Server Firebase Auth & Blueprint Guard Helper
import type { Request, Response, NextFunction } from 'express';

export const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || ${JSON.stringify(fbConfig.projectId)};
export const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || ${JSON.stringify(fbConfig.apiKey)};
export const BLUEPRINT_COLLECTIONS = ${JSON.stringify(Array.from(new Set(collectionNames)))};

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
}

export async function verifyFirebaseBearerToken(authHeader?: string): Promise<VerifiedFirebaseUser | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  // Verify token against Identity Toolkit REST API when real API key is configured
  if (FIREBASE_API_KEY && !FIREBASE_API_KEY.includes('REPLACE_WITH_')) {
    try {
      const res = await fetch(
        \`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=\${encodeURIComponent(FIREBASE_API_KEY)}\`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }
      );
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        const u = json?.users?.[0];
        if (u?.localId) {
          return {
            uid: u.localId,
            email: u.email,
            emailVerified: Boolean(u.emailVerified),
            displayName: u.displayName,
          };
        }
      }
    } catch {}
  }

  return null;
}

export function requireFirebaseAuth(req: Request, res: Response, next: NextFunction) {
  verifyFirebaseBearerToken(req.headers.authorization)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: 'Unauthorized: Valid Firebase Bearer ID token required.' });
        return;
      }
      (req as any).firebaseUser = user;
      next();
    })
    .catch(() => {
      res.status(401).json({ error: 'Unauthorized: Firebase token verification failed.' });
    });
}
`;
}

export async function provisionFirebaseForTarget(options: {
  sessionId?: string;
  targetDir?: string;
  platform?: string;
  projectId?: string;
  apiKey?: string;
  authDomain?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  firestoreDatabaseId?: string;
  blueprint?: FirebaseBlueprint;
  rules?: string;
  saveToGlobalProfile?: boolean;
  preferSavedProfile?: boolean;
}) {
  const { targetDir, relativeRoot, kind } = await resolveFirebaseTargetDir(options.sessionId, options.targetDir);
  const profile = await loadFirebaseProfile();

  const configPath = path.join(targetDir, 'firebase-config.json');
  let existingCfg: any = null;
  try {
    existingCfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {}

  const globalCfg = (profile.autoInject || options.preferSavedProfile) ? profile.webConfig : {};

  const pick = (explicit?: string, existing?: string, globalVal?: string, envVal?: string, fallback = '') => {
    for (const candidate of [explicit, existing, globalVal, envVal]) {
      if (candidate && !isPlaceholderValue(candidate)) return candidate.trim();
    }
    return fallback;
  };

  const projectId = pick(
    options.projectId,
    existingCfg?.projectId,
    globalCfg?.projectId,
    process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID,
    'your-project-id'
  );
  const apiKey = pick(
    options.apiKey,
    existingCfg?.apiKey,
    globalCfg?.apiKey,
    process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY,
    'REPLACE_WITH_FIREBASE_WEB_API_KEY'
  );

  const fbConfig: FirebaseWebConfig = {
    apiKey,
    authDomain: pick(
      options.authDomain,
      existingCfg?.authDomain,
      globalCfg?.authDomain,
      process.env.VITE_FIREBASE_AUTH_DOMAIN,
      `${projectId}.firebaseapp.com`
    ),
    projectId,
    storageBucket: pick(
      options.storageBucket,
      existingCfg?.storageBucket,
      globalCfg?.storageBucket,
      process.env.VITE_FIREBASE_STORAGE_BUCKET,
      `${projectId}.appspot.com`
    ),
    messagingSenderId: pick(
      options.messagingSenderId,
      existingCfg?.messagingSenderId,
      globalCfg?.messagingSenderId,
      process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      ''
    ),
    appId: pick(
      options.appId,
      existingCfg?.appId,
      globalCfg?.appId,
      process.env.VITE_FIREBASE_APP_ID,
      ''
    ),
    ...(options.firestoreDatabaseId || existingCfg?.firestoreDatabaseId || globalCfg?.firestoreDatabaseId
      ? {
          firestoreDatabaseId: pick(
            options.firestoreDatabaseId,
            existingCfg?.firestoreDatabaseId,
            globalCfg?.firestoreDatabaseId,
            undefined,
            ''
          ),
        }
      : {}),
  };

  const hasRealCreds = !isPlaceholderValue(fbConfig.projectId) && !isPlaceholderValue(fbConfig.apiKey);

  // Save to global profile if requested and real creds provided
  if (options.saveToGlobalProfile && hasRealCreds) {
    await saveFirebaseProfile({ webConfig: fbConfig });
  }

  const modifiedFiles: string[] = [];
  const toRel = (fileName: string) => (relativeRoot ? `${relativeRoot}/${fileName}` : fileName);

  // 1. Write firebase-config.json & firebase-applet-config.json
  await fs.writeFile(configPath, JSON.stringify(fbConfig, null, 2), 'utf-8');
  modifiedFiles.push(toRel('firebase-config.json'));
  const appletConfigPath = path.join(targetDir, 'firebase-applet-config.json');
  await fs.writeFile(appletConfigPath, JSON.stringify(fbConfig, null, 2), 'utf-8');
  modifiedFiles.push(toRel('firebase-applet-config.json'));

  // 2. Write code-matched firebase-blueprint.json (merges explicit blueprint with inferred workspace entities/collections)
  const blueprintPath = path.join(targetDir, 'firebase-blueprint.json');
  const inferredBp = await inferBlueprintFromWorkspace(targetDir, options.blueprint?.appName);
  const existingBp = await fs.readFile(blueprintPath, 'utf-8').then(JSON.parse).catch(() => null);
  let blueprintToWrite: FirebaseBlueprint;
  if (options.blueprint && Array.isArray(options.blueprint.collections) && options.blueprint.collections.length > 0) {
    blueprintToWrite = {
      ...inferredBp,
      ...options.blueprint,
      entities: { ...inferredBp.entities, ...(options.blueprint.entities || {}) },
      collections: [
        ...options.blueprint.collections,
        ...inferredBp.collections.filter(
          (ic) => !options.blueprint!.collections.some((ec) => ec.path === ic.path)
        ),
      ],
      updatedAt: Date.now(),
    };
  } else if (existingBp && Array.isArray(existingBp.collections) && existingBp.collections.length > 1) {
    blueprintToWrite = {
      ...inferredBp,
      ...existingBp,
      entities: { ...inferredBp.entities, ...(existingBp.entities || {}) },
      collections: [
        ...existingBp.collections,
        ...inferredBp.collections.filter(
          (ic) => !existingBp.collections.some((ec: any) => ec.path === ic.path)
        ),
      ],
      updatedAt: Date.now(),
    };
  } else {
    blueprintToWrite = inferredBp;
  }
  await fs.writeFile(blueprintPath, JSON.stringify(blueprintToWrite, null, 2), 'utf-8');
  modifiedFiles.push(toRel('firebase-blueprint.json'));

  // 3. Write firestore.rules (generated from blueprint if provided or not existing)
  const rulesPath = path.join(targetDir, 'firestore.rules');
  const existingRules = await fs.readFile(rulesPath, 'utf-8').catch(() => '');
  const rulesContent = options.rules
    ? options.rules
    : options.blueprint || !existingRules.trim() || blueprintToWrite.collections.length > 1
      ? generateRulesFromBlueprint(blueprintToWrite)
      : existingRules;
  await fs.writeFile(rulesPath, rulesContent, 'utf-8');
  modifiedFiles.push(toRel('firestore.rules'));

  // 4. Write SDK module, FirebaseProvider, code-matched Domain Backend Service & optional Express helper
  if (kind === 'static-project') {
    const staticHelperPath = path.join(targetDir, 'firebase-client.js');
    const staticHelper = `// Auto-generated by Nexus AI Firebase Provisioner
export const firebaseConfig = ${JSON.stringify(fbConfig, null, 2)};
export const isFirebaseConfigured = ${hasRealCreds};
`;
    await fs.writeFile(staticHelperPath, staticHelper, 'utf-8');
    modifiedFiles.push(toRel('firebase-client.js'));
  } else {
    const libPath = path.join(targetDir, 'src/lib/firebase.ts');
    await fs.mkdir(path.dirname(libPath), { recursive: true });
    await fs.writeFile(libPath, buildFirebaseSdkModule(fbConfig), 'utf-8');
    modifiedFiles.push(toRel('src/lib/firebase.ts'));

    const providerPath = path.join(targetDir, 'src/components/FirebaseProvider.tsx');
    const hasProvider = await fs.access(providerPath).then(() => true).catch(() => false);
    if (!hasProvider) {
      await fs.mkdir(path.dirname(providerPath), { recursive: true });
      await fs.writeFile(providerPath, buildFirebaseProviderModule(), 'utf-8');
      modifiedFiles.push(toRel('src/components/FirebaseProvider.tsx'));
    }

    // Write code-matched Firestore backend CRUD & realtime subscription service synced to blueprint
    const backendServicePath = path.join(targetDir, 'src/services/firebaseBackend.ts');
    await fs.mkdir(path.dirname(backendServicePath), { recursive: true });
    await fs.writeFile(backendServicePath, buildFirebaseBackendServiceModule(blueprintToWrite), 'utf-8');
    modifiedFiles.push(toRel('src/services/firebaseBackend.ts'));

    // If full-stack Express workspace exists, generate matching server/firebaseAdmin.ts helper
    const hasServerFile =
      (await fs.access(path.join(targetDir, 'server.ts')).then(() => true).catch(() => false)) ||
      (await fs.access(path.join(targetDir, 'server/routes.ts')).then(() => true).catch(() => false));
    if (hasServerFile && kind === 'workspace') {
      const serverAdminPath = path.join(targetDir, 'server/firebaseAdmin.ts');
      await fs.mkdir(path.dirname(serverAdminPath), { recursive: true });
      await fs.writeFile(serverAdminPath, buildServerFirebaseAdminHelper(fbConfig, blueprintToWrite), 'utf-8');
      modifiedFiles.push(toRel('server/firebaseAdmin.ts'));
    }

    // Ensure package.json in workspace includes firebase dependency
    const pkgPath = path.join(targetDir, 'package.json');
    try {
      const pkgRaw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(pkgRaw);
      if (pkg && typeof pkg === 'object') {
        pkg.dependencies = pkg.dependencies || {};
        if (!pkg.dependencies.firebase) {
          pkg.dependencies.firebase = '^13.3.0';
          await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
        }
      }
    } catch {}
  }

  // 5. Audit rules & attempt auto cloud deploy if Service Account / token is configured
  const audit = auditFirestoreRules(rulesContent, blueprintToWrite);
  let cloudDeployResult: Awaited<ReturnType<typeof deployRulesToFirebaseCloud>> | null = null;
  if (hasRealCreds && (profile.serviceAccount?.client_email || profile.firebaseToken || process.env.FIREBASE_TOKEN)) {
    cloudDeployResult = await deployRulesToFirebaseCloud(fbConfig.projectId, rulesContent);
  }

  return {
    success: true,
    targetRoot: relativeRoot || '.',
    workspaceKind: kind,
    configuredWithRealCredentials: hasRealCreds,
    inheritedFromGlobalProfile: Boolean((profile.autoInject || options.preferSavedProfile) && !options.projectId && hasRealCreds),
    requiresUserCredentials: !hasRealCreds,
    projectId: fbConfig.projectId,
    inferredCollections: blueprintToWrite.collections.map((c) => c.path),
    rulesAudit: audit,
    deployedRulesRemotely: Boolean(cloudDeployResult?.deployedRemotely),
    modifiedFiles,
    message: hasRealCreds
      ? cloudDeployResult?.deployedRemotely
        ? `Firebase SDK, code-matched backend (src/services/firebaseBackend.ts), blueprint & firestore.rules provisioned in "${relativeRoot || '.'}" and deployed live to "${fbConfig.projectId}".`
        : `Firebase SDK, code-matched backend (src/services/firebaseBackend.ts), blueprint & audited firestore.rules (score ${audit.securityScore}/100) auto-configured for "${fbConfig.projectId}" in "${relativeRoot || '.'}".`
      : `Code-matched Firebase backend (src/services/firebaseBackend.ts, src/lib/firebase.ts, FirebaseProvider, firebase-blueprint.json & firestore.rules) scaffolded in "${relativeRoot || '.'}" with local preview persistence. Connect a Firebase project anytime in Firebase Modal (🔥).`,
  };
}
