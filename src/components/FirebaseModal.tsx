import React, { useState, useEffect } from 'react';
import {
  X,
  Flame,
  Shield,
  CheckCircle,
  AlertCircle,
  Loader2,
  Save,
  Sparkles,
  KeyRound,
  FileCode2,
  SkipForward,
  Zap,
  Check,
  AlertTriangle,
} from 'lucide-react';
import type { PendingFirebaseSetupRequest } from '../lib/gemini';

interface RulesAuditSummary {
  valid: boolean;
  securityScore: number;
  issues: string[];
  warnings: string[];
  collectionsCovered: string[];
}

interface FirebaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string | null;
  pendingRequest?: PendingFirebaseSetupRequest | null;
  onResolvePendingRequest?: (payload: {
    action: 'connect' | 'scaffold' | 'cancel';
    configSnippet?: string;
    projectId?: string;
    apiKey?: string;
    authDomain?: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
    firestoreDatabaseId?: string;
    serviceAccountJson?: string;
    firebaseToken?: string;
    saveToGlobalProfile?: boolean;
  }) => Promise<void> | void;
}

export const FirebaseModal: React.FC<FirebaseModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  pendingRequest,
  onResolvePendingRequest,
}) => {
  const [activeTab, setActiveTab] = useState<'connect' | 'rules' | 'blueprint'>('connect');

  // Web Config state
  const [configSnippet, setConfigSnippet] = useState('');
  const [projectId, setProjectId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authDomain, setAuthDomain] = useState('');
  const [storageBucket, setStorageBucket] = useState('');
  const [messagingSenderId, setMessagingSenderId] = useState('');
  const [appId, setAppId] = useState('');
  const [firestoreDatabaseId, setFirestoreDatabaseId] = useState('');

  // Autonomous Global & Cloud Deploy Profile state
  const [autoInject, setAutoInject] = useState(true);
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const [firebaseToken, setFirebaseToken] = useState('');
  const [hasServiceAccount, setHasServiceAccount] = useState(false);
  const [serviceAccountEmail, setServiceAccountEmail] = useState('');
  const [hasFirebaseToken, setHasFirebaseToken] = useState(false);

  // Rules, Audit & Blueprint state
  const [rules, setRules] = useState('');
  const [audit, setAudit] = useState<RulesAuditSummary | null>(null);
  const [blueprint, setBlueprint] = useState<any>(null);
  const [targetRoot, setTargetRoot] = useState('.');

  // UI feedback state
  const [isLoading, setIsLoading] = useState(false);
  const [isTestingConn, setIsTestingConn] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const visible = isOpen || Boolean(pendingRequest);

  useEffect(() => {
    if (!visible) return;
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    setStatusMessage(null);
    setIsError(false);

    if (pendingRequest?.projectIdHint && !projectId) {
      setProjectId(pendingRequest.projectIdHint);
    }

    fetch(`/api/firebase/status${q}`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.targetRoot) setTargetRoot(data.targetRoot);
        if (data?.config) {
          if (data.config.projectId && !String(data.config.projectId).includes('your-project-id')) {
            setProjectId(data.config.projectId);
          }
          if (data.config.apiKey && !String(data.config.apiKey).includes('REPLACE_WITH_')) {
            setApiKey(data.config.apiKey);
          }
          if (data.config.authDomain) setAuthDomain(data.config.authDomain);
          if (data.config.storageBucket) setStorageBucket(data.config.storageBucket);
          if (data.config.messagingSenderId) setMessagingSenderId(data.config.messagingSenderId);
          if (data.config.appId) setAppId(data.config.appId);
          if (data.config.firestoreDatabaseId) setFirestoreDatabaseId(data.config.firestoreDatabaseId);
        }
        if (data?.globalProfile) {
          setAutoInject(data.globalProfile.autoInject !== false);
          setHasServiceAccount(Boolean(data.globalProfile.hasServiceAccount));
          setServiceAccountEmail(data.globalProfile.serviceAccountEmail || '');
          setHasFirebaseToken(Boolean(data.globalProfile.hasFirebaseToken));
        }
        if (data?.blueprint) setBlueprint(data.blueprint);
        if (data?.audit) setAudit(data.audit);
      })
      .catch(() => {});

    fetch(`/api/firebase/rules${q}`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.rules) setRules(data.rules);
        if (data?.audit) setAudit(data.audit);
      })
      .catch(() => {});
  }, [visible, sessionId, pendingRequest?.requestId]);

  if (!visible) return null;

  const parseSnippetLocally = (raw: string) => {
    setConfigSnippet(raw);
    const trimmed = raw.trim();
    if (!trimmed) return;

    const extract = (key: string) => {
      const m = trimmed.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`, 'i'));
      return m?.[1]?.trim() || '';
    };

    const pId = extract('projectId');
    const aKey = extract('apiKey');
    const aDomain = extract('authDomain');
    const sBucket = extract('storageBucket');
    const mSender = extract('messagingSenderId');
    const apId = extract('appId');
    const dbId = extract('firestoreDatabaseId') || extract('databaseId');

    if (pId) setProjectId(pId);
    if (aKey) setApiKey(aKey);
    if (aDomain) setAuthDomain(aDomain);
    else if (pId && !authDomain) setAuthDomain(`${pId}.firebaseapp.com`);
    if (sBucket) setStorageBucket(sBucket);
    else if (pId && !storageBucket) setStorageBucket(`${pId}.firebasestorage.app`);
    if (mSender) setMessagingSenderId(mSender);
    if (apId) setAppId(apId);
    if (dbId) setFirestoreDatabaseId(dbId);
  };

  const handleSaveGlobalAndConnect = async () => {
    if (!projectId.trim() || !apiKey.trim()) {
      setIsError(true);
      setStatusMessage('Firebase Project ID এবং Web API Key দিন (অথবা উপরে পুরো firebaseConfig পেস্ট করুন)।');
      return;
    }

    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);

    try {
      // Save optional Service Account / Token / autoInject first
      if (serviceAccountJson.trim() || firebaseToken.trim() || autoInject !== undefined) {
        const profileRes = await fetch('/api/firebase/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoInject,
            ...(serviceAccountJson.trim() ? { serviceAccountJson: serviceAccountJson.trim() } : {}),
            ...(firebaseToken.trim() ? { firebaseToken: firebaseToken.trim() } : {}),
          }),
        });
        const profileData = await profileRes.json();
        if (!profileRes.ok) {
          throw new Error(profileData.error || 'Failed to save Firebase global profile');
        }
        setHasServiceAccount(Boolean(profileData.hasServiceAccount));
        setServiceAccountEmail(profileData.serviceAccountEmail || '');
        setHasFirebaseToken(Boolean(profileData.hasFirebaseToken));
      }

      // If Nexus AI is paused waiting for credentials mid-build, resume immediately!
      if (pendingRequest && onResolvePendingRequest) {
        await onResolvePendingRequest({
          action: 'connect',
          configSnippet: configSnippet.trim() || undefined,
          projectId: projectId.trim(),
          apiKey: apiKey.trim(),
          authDomain: authDomain.trim() || undefined,
          storageBucket: storageBucket.trim() || undefined,
          messagingSenderId: messagingSenderId.trim() || undefined,
          appId: appId.trim() || undefined,
          firestoreDatabaseId: firestoreDatabaseId.trim() || undefined,
          serviceAccountJson: serviceAccountJson.trim() || undefined,
          firebaseToken: firebaseToken.trim() || undefined,
          saveToGlobalProfile: true,
        });
        setStatusMessage(`Firebase "${projectId.trim()}" কানেক্ট হয়েছে এবং Nexus AI কাজ শুরু করেছে!`);
        return;
      }

      const res = await fetch('/api/firebase/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          configSnippet: configSnippet.trim() || undefined,
          projectId: projectId.trim(),
          apiKey: apiKey.trim(),
          authDomain: authDomain.trim() || undefined,
          storageBucket: storageBucket.trim() || undefined,
          messagingSenderId: messagingSenderId.trim() || undefined,
          appId: appId.trim() || undefined,
          firestoreDatabaseId: firestoreDatabaseId.trim() || undefined,
          autoInject,
          saveToGlobalProfile: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to initialize Firebase');
      }
      if (data.rulesAudit) setAudit(data.rulesAudit);
      setStatusMessage(
        data.message || `Firebase "${projectId.trim()}" স্বয়ংক্রিয়ভাবে কানেক্ট ও প্রোভিশন হয়েছে!`
      );
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err?.message || 'Failed to connect Firebase');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTestingConn(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      if (serviceAccountJson.trim() || firebaseToken.trim()) {
        await fetch('/api/firebase/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoInject,
            ...(serviceAccountJson.trim() ? { serviceAccountJson: serviceAccountJson.trim() } : {}),
            ...(firebaseToken.trim() ? { firebaseToken: firebaseToken.trim() } : {}),
          }),
        });
      }
      const res = await fetch('/api/firebase/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setIsError(true);
        setStatusMessage(data.message || 'Service Account connection check failed.');
      } else {
        setHasServiceAccount(true);
        setStatusMessage(data.message || 'Firebase Rules API connection verified!');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err?.message || 'Connection test failed');
    } finally {
      setIsTestingConn(false);
    }
  };

  const handleAuditRules = async () => {
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/firebase/audit-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules, sessionId: sessionId || undefined }),
      });
      const data = await res.json();
      setAudit(data);
      if (data.valid) {
        setStatusMessage(`Security Audit সম্পন্ন — স্কোর: ${data.securityScore}/100`);
      } else {
        setIsError(true);
        setStatusMessage(`Syntax এরর: ${(data.issues || []).join(' | ')}`);
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err?.message || 'Audit failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveRules = async () => {
    setIsLoading(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const res = await fetch('/api/firebase/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules, sessionId: sessionId || undefined }),
      });
      const data = await res.json();
      if (data.audit) setAudit(data.audit);
      if (res.ok && data.success) {
        setStatusMessage(data.message || 'Firestore security rules updated successfully.');
      } else {
        setIsError(true);
        setStatusMessage(data.error || data.message || 'Failed to deploy rules');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err?.message || 'Failed to update rules');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkipPending = async () => {
    if (pendingRequest && onResolvePendingRequest) {
      await onResolvePendingRequest({ action: 'scaffold' });
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-[#0f172a]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">Nexus Autonomous Firebase Engine</h3>
                {audit && (
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                      audit.securityScore >= 85
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    }`}
                  >
                    Audit {audit.securityScore}/100
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Target: <span className="text-slate-300 font-mono">{targetRoot}</span> · Auto Blueprint, SDK &amp; Rules
              </p>
            </div>
          </div>
          <button
            onClick={pendingRequest ? handleSkipPending : onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Interactive Agent Prompt Banner */}
        {pendingRequest && (
          <div className="px-5 py-3 bg-amber-500/10 border-b border-amber-500/25 flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 text-xs">
              <p className="font-semibold text-amber-200">
                Nexus AI অটোমেটিক Firebase সেটআপ করতে চায়
              </p>
              <p className="text-amber-300/80 text-[11px] mt-0.5">
                {pendingRequest.reason || 'নিচে আপনার Firebase Config পেস্ট করে Connect করুন—অথবা Skip করলে লোকাল Scaffold মোডে অ্যাপ তৈরি চালিয়ে যাবে।'}
              </p>
              {pendingRequest.collections && pendingRequest.collections.length > 0 && (
                <p className="text-[11px] text-slate-300 mt-1 font-mono">
                  Collections: {pendingRequest.collections.join(', ')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="px-5 pt-3 border-b border-slate-800 flex items-center gap-2 bg-[#0b1329]">
          <button
            type="button"
            onClick={() => setActiveTab('connect')}
            className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'connect'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Auto Connect &amp; Profile</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rules')}
            className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'rules'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Security Rules &amp; Audit</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('blueprint')}
            className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'blueprint'
                ? 'border-amber-400 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode2 className="w-3.5 h-3.5" />
            <span>Blueprint Schema</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {activeTab === 'connect' && (
            <>
              {/* 1-Click Config Snippet Paste */}
              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold flex items-center justify-between">
                  <span>১-ক্লিক Config পেস্ট (Firebase Console থেকে `firebaseConfig` পেস্ট করুন)</span>
                  <span className="text-[10px] text-amber-400 font-normal">Auto-parses JSON / JS</span>
                </label>
                <textarea
                  rows={3}
                  value={configSnippet}
                  onChange={(e) => parseSnippetLocally(e.target.value)}
                  placeholder={`const firebaseConfig = {\n  apiKey: "AIzaSy...",\n  authDomain: "my-app.firebaseapp.com",\n  projectId: "my-app",\n  ...\n};`}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-amber-500 resize-none"
                />
              </div>

              {/* Individual Config Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Project ID *</label>
                  <input
                    type="text"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder="my-firebase-project"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Web API Key *</label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Auth Domain</label>
                  <input
                    type="text"
                    value={authDomain}
                    onChange={(e) => setAuthDomain(e.target.value)}
                    placeholder="project-id.firebaseapp.com"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">App ID</label>
                  <input
                    type="text"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="1:123456:web:abcdef"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Storage Bucket</label>
                  <input
                    type="text"
                    value={storageBucket}
                    onChange={(e) => setStorageBucket(e.target.value)}
                    placeholder="project-id.firebasestorage.app"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400 font-medium">Firestore Database ID (Optional)</label>
                  <input
                    type="text"
                    value={firestoreDatabaseId}
                    onChange={(e) => setFirestoreDatabaseId(e.target.value)}
                    placeholder="(default) অথবা custom-db-id"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              {/* Global Auto-Inject Toggle */}
              <label className="flex items-center justify-between p-3 rounded-xl bg-slate-900/90 border border-slate-800 cursor-pointer">
                <div>
                  <div className="text-slate-200 font-semibold">Save for Chat &amp; Firebase Projects</div>
                  <div className="text-[11px] text-slate-400">
                    এখানে কনফিগ সেভ করলে পরবর্তীতে চ্যাটে ফায়ারবেজ সেটআপ করতে বললেই Nexus AI স্বয়ংক্রিয়ভাবে এটি ব্যবহার করবে
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoInject}
                  onChange={(e) => setAutoInject(e.target.checked)}
                  className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                />
              </label>

              {/* Live Cloud Rules Deploy Credentials (Optional) */}
              <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-200 font-semibold">
                    <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                    <span>Live Cloud Rules Auto-Deploy (ঐচ্ছিক)</span>
                  </div>
                  {(hasServiceAccount || hasFirebaseToken) && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      {hasServiceAccount ? serviceAccountEmail || 'Service Account Connected' : 'CLI Token Ready'}
                    </span>
                  )}
                </div>

                <textarea
                  rows={2}
                  value={serviceAccountJson}
                  onChange={(e) => setServiceAccountJson(e.target.value)}
                  placeholder="Service Account JSON পেস্ট করুন (অটো firestore.rules লাইভ ডিপ্লয়ের জন্য — সম্পূর্ণ সার্ভার-সাইডে সংরক্ষিত থাকবে)"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-amber-500 resize-none"
                />

                <div className="flex gap-2">
                  <input
                    type="password"
                    value={firebaseToken}
                    onChange={(e) => setFirebaseToken(e.target.value)}
                    placeholder="অথবা FIREBASE_TOKEN (firebase login:ci)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-white text-xs font-mono focus:outline-none focus:border-amber-500"
                  />
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={isTestingConn}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {isTestingConn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Test API</span>}
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'rules' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-semibold flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-amber-400" />
                  <span>firestore.rules ({targetRoot})</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAuditRules}
                    disabled={isLoading}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold cursor-pointer"
                  >
                    Run Audit
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveRules}
                    disabled={isLoading}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Save className="w-3 h-3" />
                    <span>Save &amp; Deploy</span>
                  </button>
                </div>
              </div>

              <textarea
                rows={11}
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                placeholder="rules_version = '2'; service cloud.firestore { ... }"
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-100 font-mono text-[11px] focus:outline-none focus:border-amber-500 resize-none leading-relaxed"
              />

              {audit && (
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-200">
                      Security Audit Score: {audit.securityScore}/100
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Collections: {audit.collectionsCovered?.join(', ') || 'default'}
                    </span>
                  </div>
                  {audit.issues?.map((issue, idx) => (
                    <div key={`i-${idx}`} className="flex items-start gap-2 text-[11px] text-rose-300">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span>{issue}</span>
                    </div>
                  ))}
                  {audit.warnings?.map((warn, idx) => (
                    <div key={`w-${idx}`} className="flex items-start gap-2 text-[11px] text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span>{warn}</span>
                    </div>
                  ))}
                  {audit.issues?.length === 0 && audit.warnings?.length === 0 && (
                    <div className="flex items-center gap-2 text-[11px] text-emerald-300">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>All security checks passed cleanly!</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'blueprint' && (
            <div className="space-y-3">
              <p className="text-slate-400 text-[11px]">
                Active schema blueprint (<code className="text-slate-300">firebase-blueprint.json</code>) used by Nexus AI to synthesize TypeScript models and Firestore rules:
              </p>
              <pre className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3.5 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-72">
                {blueprint
                  ? JSON.stringify(blueprint, null, 2)
                  : '// No firebase-blueprint.json generated for this workspace yet. Ask Nexus AI to build any Firebase/Firestore feature!'}
              </pre>
            </div>
          )}

          {statusMessage && (
            <div
              className={`p-3 rounded-xl border flex items-center gap-2 text-[11px] ${
                isError
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              }`}
            >
              {isError ? (
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
              ) : (
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
              )}
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-[#0f172a] flex items-center justify-between gap-2">
          {pendingRequest ? (
            <>
              <button
                type="button"
                onClick={handleSkipPending}
                disabled={isLoading}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <SkipForward className="w-3.5 h-3.5" />
                <span>Use Local Scaffold (Skip)</span>
              </button>
              <button
                type="button"
                onClick={handleSaveGlobalAndConnect}
                disabled={isLoading}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-lg shadow-amber-600/20"
              >
                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                <span>Connect &amp; Continue Build</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-xs cursor-pointer"
              >
                Close
              </button>
              {activeTab === 'connect' && (
                <button
                  type="button"
                  onClick={handleSaveGlobalAndConnect}
                  disabled={isLoading}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-amber-600/20"
                >
                  {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />}
                  <span>Save &amp; Auto-Provision</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
