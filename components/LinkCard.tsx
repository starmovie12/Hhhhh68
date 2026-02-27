'use client';

import { Video, CircleCheck, CircleDashed, Copy, Check, AlertCircle, ExternalLink } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

interface LinkCardProps {
  id: number;
  name: string;
  logs: LogEntry[];
  finalLink: string | null;
  status: 'processing' | 'done' | 'error';
}

export default function LinkCard({ id, name, logs, finalLink, status }: LinkCardProps) {
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [logs]);

  const handleCopy = async () => {
    if (!finalLink) return;
    try {
      await navigator.clipboard.writeText(finalLink);
      setCopied(true);
      if (navigator.vibrate) navigator.vibrate(50);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const el = document.createElement('textarea');
      el.value = finalLink;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'done': return 'border-emerald-500 bg-emerald-500/5';
      case 'error': return 'border-rose-500 bg-rose-500/5';
      default: return 'border-indigo-500/50 bg-white/5';
    }
  };

  const getLogColor = (type: string) => {
    switch (type) {
      case 'success': return 'text-emerald-400 font-bold';
      case 'error': return 'text-rose-400';
      case 'warn': return 'text-amber-400';
      case 'info': return 'text-blue-400';
      default: return 'text-slate-400';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-4 mb-3 rounded-2xl border-l-4 border backdrop-blur-md transition-all duration-300 ${getStatusColor()}`}
    >
      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-sm font-bold flex items-center gap-2 truncate max-w-[80%]">
          <Video className="w-4 h-4 text-indigo-400 flex-shrink-0" />
          <span className="truncate">{name}</span>
        </span>
        {status === 'processing' ? (
          <CircleDashed className="w-5 h-5 text-indigo-400 animate-spin flex-shrink-0" />
        ) : status === 'done' ? (
          <CircleCheck className="w-5 h-5 text-emerald-400 flex-shrink-0" />
        ) : (
          <AlertCircle className="w-5 h-5 text-rose-400 flex-shrink-0" />
        )}
      </div>

      {/* Live Logs Terminal */}
      {logs.length > 0 && (
        <div
          ref={logEndRef}
          className="bg-black/80 p-3 rounded-lg font-mono text-[11px] max-h-[120px] overflow-y-auto border border-white/5 scrollbar-hide mb-3"
        >
          {logs.map((log, i) => (
            <div key={i} className={`mb-1 ${getLogColor(log.type)}`}>
              {`> ${log.msg}`}
            </div>
          ))}
          {status === 'processing' && (
            <div className="text-slate-500 animate-pulse mt-1">{'> Processing...'}</div>
          )}
        </div>
      )}

      {/* No logs but processing */}
      {logs.length === 0 && status === 'processing' && (
        <div className="bg-black/80 p-3 rounded-lg font-mono text-[11px] border border-white/5 mb-3">
          <div className="text-slate-500 animate-pulse">{'> Queued for processing...'}</div>
        </div>
      )}

      {/* Final Link */}
      <AnimatePresence>
        {finalLink && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="relative overflow-hidden space-y-2"
          >
            {/* Copy button */}
            <div
              onClick={handleCopy}
              className="w-full bg-emerald-500/10 border border-emerald-500/40 text-emerald-400 py-3 px-4 rounded-xl font-mono text-xs font-bold cursor-pointer hover:bg-emerald-500/20 transition-all flex items-center justify-between gap-2"
            >
              <span className="truncate flex-1">{copied ? 'COPIED TO CLIPBOARD! ✅' : finalLink}</span>
              {copied ? <Check className="w-4 h-4 flex-shrink-0" /> : <Copy className="w-4 h-4 flex-shrink-0" />}
            </div>
            {/* Open link button */}
            <a
              href={finalLink}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-indigo-500/20 transition-all"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open Download Link
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
