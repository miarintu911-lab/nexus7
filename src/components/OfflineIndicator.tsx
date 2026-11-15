import React, { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 px-3 py-1.5 bg-amber-500/15 border border-amber-500/30 text-amber-300 rounded-xl text-xs backdrop-blur-md shadow-xl animate-pulse">
      <WifiOff className="w-3.5 h-3.5" />
      <span>অফলাইন মোড সক্রিয় — IndexedDB ক্যাশ লোড করা হয়েছে</span>
    </div>
  );
};
