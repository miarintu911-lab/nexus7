import React, { useState, useEffect } from 'react';
import { Download, Smartphone, Share, MoreVertical, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export const PWAInstallButton: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      setShowGuideModal(false);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  if (isInstalled) return null;

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstalled(true);
      }
      setDeferredPrompt(null);
      return;
    }
    setShowGuideModal(true);
  };

  return (
    <>
      <button
        onClick={handleInstallClick}
        className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full sm:rounded-xl text-[11px] font-semibold transition-all shadow-md shadow-emerald-600/20 cursor-pointer flex-shrink-0"
        title="মোবাইলে Nexus AI অ্যাপ ইন্সটল করুন"
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Install App</span>
      </button>

      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#0f172a] border border-slate-700 rounded-2xl p-5 shadow-2xl space-y-4 text-left">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">মোবাইলে অ্যাপ ইন্সটল করুন</h3>
                  <p className="text-[11px] text-slate-400">Nexus AI PWA App</p>
                </div>
              </div>
              <button
                onClick={() => setShowGuideModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
                <p className="text-slate-200 font-medium">iPhone / iPad (Safari) থেকে ইন্সটল করতে:</p>
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <Share className="w-4 h-4 text-sky-400 flex-shrink-0" />
                    <span>১. Safari-র নিচে বা উপরে <strong>Share</strong> বাটনে চাপুন।</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span>২. স্ক্রল করে <strong>&quot;Add to Home Screen&quot;</strong> সিলেক্ট করুন।</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5 text-xs text-slate-300 leading-relaxed">
                <p className="text-slate-200 font-medium">Android (Chrome / Edge) থেকে ইন্সটল করতে:</p>
                <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <MoreVertical className="w-4 h-4 text-sky-400 flex-shrink-0" />
                    <span>১. ব্রাউজারের ডানদিকের উপরে <strong>⋮ (Menu)</strong> বাটনে চাপুন।</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    <span>২. <strong>&quot;Install app&quot;</strong> অথবা <strong>&quot;Add to Home screen&quot;</strong> সিলেক্ট করে কনফার্ম করুন।</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">
                  টিপস: সরাসরি Render-এর লাইভ HTTPS লিংক থেকে Chrome-এ খুললে এক ক্লিকেই নেটিভ ইন্সটল পপআপ আসবে।
                </p>
              </div>
            )}

            <button
              onClick={() => setShowGuideModal(false)}
              className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
            >
              বুঝেছি (Close)
            </button>
          </div>
        </div>
      )}
    </>
  );
};
