import React, { useState, useEffect } from 'react';
import { HelpCircle, Check, SkipForward, Send, X } from 'lucide-react';
import { cn } from '../lib/utils';

export interface AskQuestionItem {
  question: string;
  options: string[];
  is_multi_select?: boolean;
}

export interface PendingQuestionPrompt {
  questionId: string;
  questions: AskQuestionItem[];
}

interface AskQuestionModalProps {
  pendingQuestion: PendingQuestionPrompt | null;
  isSubmitting?: boolean;
  onSubmit: (answers: Record<string, string[]>, notes: string) => void;
  onSkip: () => void;
}

export const AskQuestionModal: React.FC<AskQuestionModalProps> = ({
  pendingQuestion,
  isSubmitting = false,
  onSubmit,
  onSkip,
}) => {
  const [selectedMap, setSelectedMap] = useState<Record<number, string[]>>({});
  const [customMap, setCustomMap] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (pendingQuestion) {
      setSelectedMap({});
      setCustomMap({});
      setNotes('');
    }
  }, [pendingQuestion?.questionId]);

  if (!pendingQuestion) return null;

  const toggleOption = (qIndex: number, option: string, isMulti?: boolean) => {
    setSelectedMap((prev) => {
      const current = prev[qIndex] || [];
      if (isMulti) {
        const exists = current.includes(option);
        return {
          ...prev,
          [qIndex]: exists ? current.filter((o) => o !== option) : [...current, option],
        };
      }
      return {
        ...prev,
        [qIndex]: current.includes(option) ? [] : [option],
      };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formatted: Record<string, string[]> = {};
    pendingQuestion.questions.forEach((q, idx) => {
      const chosen = [...(selectedMap[idx] || [])];
      const custom = (customMap[idx] || '').trim();
      if (custom) chosen.push(custom);
      formatted[q.question] = chosen;
    });
    onSubmit(formatted, notes.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl bg-[#18191d] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-[#1c1d22]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <HelpCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Nexus Clarifying Questions</h3>
              <p className="text-[11px] text-slate-400">সঠিক ডিজাইন ও ফিচার নির্ধারণের জন্য উত্তর দিন অথবা Skip করুন</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSkip}
            disabled={isSubmitting}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            title="Skip with defaults"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-5">
          {pendingQuestion.questions.map((q, qIdx) => {
            const selected = selectedMap[qIdx] || [];
            return (
              <div key={qIdx} className="bg-[#131314] border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100 leading-snug">
                    {qIdx + 1}. {q.question}
                  </p>
                  {q.is_multi_select && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 flex-shrink-0">
                      Multi-select
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(q.options || []).map((opt, oIdx) => {
                    const isActive = selected.includes(opt);
                    return (
                      <button
                        key={oIdx}
                        type="button"
                        onClick={() => toggleOption(qIdx, opt, q.is_multi_select)}
                        className={cn(
                          "text-left px-3 py-2.5 rounded-xl border text-xs font-medium transition-all flex items-center justify-between gap-2 cursor-pointer",
                          isActive
                            ? "bg-indigo-600/20 border-indigo-500 text-indigo-200 shadow-sm"
                            : "bg-[#1c1d22] border-slate-800 text-slate-300 hover:border-slate-600 hover:text-white"
                        )}
                      >
                        <span className="leading-snug">{opt}</span>
                        <span
                          className={cn(
                            "w-4 h-4 flex items-center justify-center border flex-shrink-0",
                            q.is_multi_select ? "rounded" : "rounded-full",
                            isActive
                              ? "bg-indigo-500 border-indigo-400 text-white"
                              : "border-slate-600 bg-transparent"
                          )}
                        >
                          {isActive && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <input
                  type="text"
                  value={customMap[qIdx] || ''}
                  onChange={(e) => setCustomMap((prev) => ({ ...prev, [qIdx]: e.target.value }))}
                  placeholder="অন্য কোনো পছন্দ থাকলে লিখুন (ঐচ্ছিক)..."
                  className="w-full bg-[#1c1d22] border border-slate-800 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
                />
              </div>
            );
          })}

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-slate-400 block">
              অতিরিক্ত নির্দেশনা (ঐচ্ছিক)
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="কোনো অতিরিক্ত ডিজাইন বা টেকনিক্যাল নির্দেশনা..."
              className="w-full bg-[#131314] border border-slate-800 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onSkip}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <SkipForward className="w-3.5 h-3.5" />
              <span>Skip (Defaults)</span>
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-indigo-600/20 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Sending...' : 'Submit & Continue'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
