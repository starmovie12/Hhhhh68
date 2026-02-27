'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bolt, Link as LinkIcon, Rocket, Loader2, RotateCcw, AlertTriangle, CircleCheck,
  History, ChevronRight, ChevronDown, Film, Globe, Volume2, Sparkles, Home,
  Clock, CheckCircle2, XCircle, Trash2, RefreshCw, Bot, ListVideo,
  Zap, Cpu, Radio, TrendingUp, Tv2, Play, Pause, RefreshCcw,
  AlertCircle, ChevronUp, Eye, Cloud, Smartphone, Wifi, WifiOff, Shield, Activity,
  Settings,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LinkCard from '@/components/LinkCard';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface LogEntry { msg: string; type: 'info' | 'success' | 'error' | 'warn'; }

interface Task {
  id: string;
  url: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: string;
  links: any[];
  error?: string;
  extractedBy?: 'Browser/Live' | 'Server/Auto-Pilot';
  preview?: { title: string; posterUrl: string | null };
  metadata?: { quality: string; languages: string; audioLabel: string };
}

interface QueueItem {
  id: string; collection: string; type: 'movie' | 'webseries';
  url: string; title?: string; status: string; createdAt?: string;
}

interface QueueStats {
  totalPending: number; totalCompleted: number; totalFailed: number;
  totalAll: number; pendingItems: QueueItem[];
}

interface EngineStatus {
  signal: 'ONLINE' | 'OFFLINE'; status: string; lastRunAt: string | null;
  timeSinceLastRun: string; details: string; backgroundActive: boolean;
  pendingCount: number; processingCount: number;
}

type TabType = 'home' | 'processing' | 'completed' | 'failed' | 'history';
type AutoPilotPhase = 'idle' | 'fetching' | 'running' | 'done' | 'stopped';

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatTime12h(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return isoString; }
}

function getLinkStats(links: any[]) {
  if (!links || links.length === 0) return { total: 0, done: 0, failed: 0, pending: 0 };
  let done = 0, failed = 0, pending = 0;
  for (const link of links) {
    const s = (link.status || '').toLowerCase();
    if (s === 'done' || s === 'success') done++;
    else if (s === 'error' || s === 'failed') failed++;
    else pending++;
  }
  return { total: links.length, done, failed, pending };
}

const PulseDot = ({ color = 'bg-emerald-400' }: { color?: string }) => (
  <span className="relative flex h-2 w-2 flex-shrink-0">
    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-75`} />
    <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
  </span>
);

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function MflixApp() {
  // Manual process states
  const [url, setUrl] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('home');
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<number, LogEntry[]>>({});
  const [liveLinks, setLiveLinks] = useState<Record<number, string | null>>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<number, string>>({});
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);

  const streamStartedRef = useRef<Set<string>>(new Set());
  const completedLinksRef = useRef<Record<string, Record<number, any>>>({});
  const streamEndedAtRef = useRef<Record<string, number>>({});
  const enginePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-Pilot states
  const [autoPilotPhase, setAutoPilotPhase] = useState<AutoPilotPhase>('idle');
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [currentQueueItem, setCurrentQueueItem] = useState<QueueItem | null>(null);
  const [autoPilotProcessed, setAutoPilotProcessed] = useState(0);
  const [autoPilotStatusMsg, setAutoPilotStatusMsg] = useState('');
  const [autoPilotLog, setAutoPilotLog] = useState<LogEntry[]>([]);
  const [showQueuePreview, setShowQueuePreview] = useState(false);
  const [showAutoPilotLog, setShowAutoPilotLog] = useState(false);
  const autoPilotActiveRef = useRef(false);
  const autoPilotLogRef = useRef<LogEntry[]>([]);

  // Engine status
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);

  // ─── Firebase Re-hydration on mount ───────────────────────────────────────────
  const rehydrateFromFirebase = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setTasks(data);
      const processingTask = data.find((t: Task) => t.status === 'processing');
      if (processingTask) {
        setExpandedTask(processingTask.id);
        setActiveTab('processing');
      }
    } catch (e) { console.error('Rehydration failed:', e); }
  }, []);

  // ─── Task Polling ──────────────────────────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (!ct || !ct.includes('application/json')) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      setTasks(prev => {
        const now = Date.now();
        return data.map((serverTask: Task) => {
          if (streamStartedRef.current.has(serverTask.id)) {
            const local = prev.find(t => t.id === serverTask.id);
            if (local) return local;
          }
          const endedAt = streamEndedAtRef.current[serverTask.id];
          const isRecentlyEnded = endedAt && (now - endedAt < 15000);
          const shieldData = completedLinksRef.current[serverTask.id] || {};
          const mergedLinks = (serverTask.links || []).map((fbLink: any, idx: number) => {
            const protected_ = shieldData[idx];
            if (protected_) {
              const fbStatus = (fbLink.status || '').toLowerCase();
              const isFbPending = fbStatus === 'pending' || fbStatus === 'processing' || fbStatus === '';
              if (isFbPending || isRecentlyEnded) {
                return { ...fbLink, status: protected_.status, finalLink: protected_.finalLink || fbLink.finalLink, logs: protected_.logs || fbLink.logs };
              }
            }
            return fbLink;
          });
          const allDone = mergedLinks.length > 0 && mergedLinks.every((l: any) => {
            const s = (l.status || '').toLowerCase();
            return s === 'done' || s === 'success' || s === 'error' || s === 'failed';
          });
          const anySuccess = mergedLinks.some((l: any) => {
            const s = (l.status || '').toLowerCase();
            return s === 'done' || s === 'success';
          });
          let newStatus = serverTask.status;
          if (allDone) newStatus = anySuccess ? 'completed' : 'failed';
          else if (isRecentlyEnded) newStatus = 'processing';
          return { ...serverTask, status: newStatus, links: mergedLinks };
        });
      });
    } catch (e) { console.error('fetchTasks error:', e); }
  }, []);

  const fetchEngineStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/engine-status');
      if (!res.ok) return;
      const data = await res.json();
      setEngineStatus(data);
    } catch {}
  }, []);

  useEffect(() => {
    rehydrateFromFirebase();
    fetchEngineStatus();
    const pollInterval = setInterval(fetchTasks, 5000);
    enginePollRef.current = setInterval(fetchEngineStatus, 20000);
    return () => {
      clearInterval(pollInterval);
      if (enginePollRef.current) clearInterval(enginePollRef.current);
    };
  }, [rehydrateFromFirebase, fetchTasks, fetchEngineStatus]);

  // ─── Stats helpers ─────────────────────────────────────────────────────────────
  const getEffectiveStats = useCallback((task: Task) => {
    const isLive = activeTaskId === task.id;
    const shieldData = completedLinksRef.current[task.id] || {};
    const total = task.links?.length || 0;
    let done = 0, failed = 0, pending = 0;
    for (let i = 0; i < total; i++) {
      let s = '';
      if (isLive && liveStatuses[i]) s = liveStatuses[i];
      else if (shieldData[i]) s = shieldData[i].status;
      else s = task.links[i]?.status || '';
      s = s.toLowerCase();
      if (s === 'done' || s === 'success') done++;
      else if (s === 'error' || s === 'failed') failed++;
      else pending++;
    }
    return { total, done, failed, pending };
  }, [activeTaskId, liveStatuses]);

  const getTrueTaskStatus = (task: Task, stats: ReturnType<typeof getEffectiveStats>) => {
    if (activeTaskId === task.id) return 'processing';
    if (stats.total > 0 && stats.pending === 0) return stats.done > 0 ? 'completed' : 'failed';
    return task.status;
  };

  // ─── Live Stream ───────────────────────────────────────────────────────────────
  const startLiveStream = useCallback(async (taskId: string, links: any[]) => {
    if (streamStartedRef.current.has(taskId)) return;
    const shieldData = completedLinksRef.current[taskId] || {};
    const pendingLinks = links
      .map((l: any, idx: number) => ({ ...l, _originalIdx: idx }))
      .filter((l: any) => {
        if (shieldData[l._originalIdx]) return false;
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === 'processing' || s === '';
      });
    if (pendingLinks.length === 0) return;

    streamStartedRef.current.add(taskId);
    setActiveTaskId(taskId);
    if (!completedLinksRef.current[taskId]) completedLinksRef.current[taskId] = {};

    const initLogs: Record<number, LogEntry[]> = {};
    const initLinks: Record<number, string | null> = {};
    const initStatuses: Record<number, string> = {};

    links.forEach((link: any, idx: number) => {
      if (shieldData[idx]) {
        initLogs[idx] = shieldData[idx].logs || [];
        initLinks[idx] = shieldData[idx].finalLink || null;
        initStatuses[idx] = shieldData[idx].status;
      } else {
        const s = (link.status || '').toLowerCase();
        if (s === 'done' || s === 'success') {
          initLogs[idx] = link.logs || [];
          initLinks[idx] = link.finalLink || null;
          initStatuses[idx] = 'done';
          completedLinksRef.current[taskId][idx] = { status: 'done', finalLink: link.finalLink, logs: link.logs };
        } else if (s === 'error' || s === 'failed') {
          initLogs[idx] = [{ msg: '🔄 Retrying...', type: 'info' }];
          initLinks[idx] = null;
          initStatuses[idx] = 'processing';
        } else {
          initLogs[idx] = [];
          initLinks[idx] = null;
          initStatuses[idx] = 'processing';
        }
      }
    });

    setLiveLogs(initLogs);
    setLiveLinks(initLinks);
    setLiveStatuses(initStatuses);

    try {
      const linksToSend = pendingLinks.map((l: any) => ({ id: l._originalIdx, name: l.name, link: l.link }));
      const response = await fetch('/api/stream_solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: linksToSend, taskId, extractedBy: 'Browser/Live' }),
      });
      if (!response.ok || !response.body) {
        setLiveStatuses(prev => {
          const u = { ...prev };
          pendingLinks.forEach((l: any) => { u[l._originalIdx] = 'error'; });
          return u;
        });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const lid = data.id;
            if (data.msg && data.type) {
              setLiveLogs(prev => ({ ...prev, [lid]: [...(prev[lid] || []), { msg: data.msg, type: data.type }] }));
            }
            if (data.final) setLiveLinks(prev => ({ ...prev, [lid]: data.final }));
            if (data.status === 'done' || data.status === 'error') {
              setLiveStatuses(prev => ({ ...prev, [lid]: data.status }));
              setLiveLogs(currentLogs => {
                setLiveLinks(currentLinks => {
                  completedLinksRef.current[taskId][lid] = {
                    status: data.status,
                    finalLink: data.final || currentLinks[lid],
                    best_button_name: data.best_button_name,
                    logs: currentLogs[lid] || [],
                  };
                  return currentLinks;
                });
                return currentLogs;
              });
            }
            if (data.status === 'finished') {
              setLiveStatuses(prev => {
                if (prev[lid] !== 'done' && prev[lid] !== 'error') {
                  completedLinksRef.current[taskId][lid] = { status: 'error', logs: [] };
                  return { ...prev, [lid]: 'error' };
                }
                return prev;
              });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      console.error('[Stream] error:', e);
    } finally {
      streamStartedRef.current.delete(taskId);
      streamEndedAtRef.current[taskId] = Date.now();
      setTimeout(fetchTasks, 1000);
      setActiveTaskId(null);
    }
  }, [fetchTasks]);

  // ─── Auto-Pilot ─────────────────────────────────────────────────────────────────
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const addAutoPilotLog = (msg: string, type: LogEntry['type'] = 'info') => {
    const entry = { msg, type };
    autoPilotLogRef.current = [entry, ...autoPilotLogRef.current].slice(0, 100);
    setAutoPilotLog([...autoPilotLogRef.current]);
  };

  const fetchFirebaseQueue = async (): Promise<{ stats: QueueStats; pendingItems: QueueItem[] }> => {
    const res = await fetch('/api/auto-process/queue?type=all');
    if (!res.ok) throw new Error(`Queue API failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data.status === 'error') throw new Error(data.message || 'Queue API error');
    const allItems: QueueItem[] = Array.isArray(data.items) ? data.items : [];
    const pendingItems = allItems.filter(i => (i.status || '').toLowerCase() === 'pending');
    const completedItems = allItems.filter(i => (i.status || '').toLowerCase() === 'completed');
    const failedItems = allItems.filter(i => ['failed', 'error'].includes((i.status || '').toLowerCase()));
    return {
      stats: {
        totalPending: pendingItems.length,
        totalCompleted: completedItems.length,
        totalFailed: failedItems.length,
        totalAll: allItems.length,
        pendingItems,
      },
      pendingItems,
    };
  };

  const patchQueueStatus = async (item: QueueItem, status: string, errorMsg?: string) => {
    try {
      await fetch('/api/auto-process/queue', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, collection: item.collection, status, error: errorMsg }),
      });
    } catch {}
  };

  const processQueueItemAutoPilot = async (item: QueueItem): Promise<boolean> => {
    const trimmedUrl = (item.url || '').trim();
    if (!trimmedUrl) {
      addAutoPilotLog(`⚠️ Skipping — no URL`, 'warn');
      return false;
    }
    try {
      addAutoPilotLog(`📋 Creating task for "${item.title || 'Unknown'}"...`, 'info');
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl }),
      });
      if (!res.ok) {
        addAutoPilotLog(`❌ Task creation failed: HTTP ${res.status}`, 'error');
        await patchQueueStatus(item, 'failed', `HTTP ${res.status}`);
        return false;
      }
      const data = await res.json();
      if (data.error) {
        addAutoPilotLog(`❌ Error: ${data.error}`, 'error');
        await patchQueueStatus(item, 'failed', data.error);
        return false;
      }
      const taskId = data.taskId;
      await fetchTasks();
      setExpandedTask(taskId);
      setActiveTab('processing');

      // Get pending links
      const taskRes = await fetch('/api/tasks');
      const taskList = await taskRes.json();
      const newTask = Array.isArray(taskList) ? taskList.find((t: any) => t.id === taskId) : null;
      const allLinks = newTask?.links || [];
      const pendingLinks = allLinks
        .map((l: any, i: number) => ({ ...l, id: i }))
        .filter((l: any) => {
          const s = (l.status || '').toLowerCase();
          return s === 'pending' || s === '' || s === 'processing';
        });

      if (pendingLinks.length === 0) {
        addAutoPilotLog(`⚠️ No pending links`, 'warn');
        await patchQueueStatus(item, 'completed');
        return true;
      }

      addAutoPilotLog(`⚡ Solving ${pendingLinks.length} links on server...`, 'info');
      const solveRes = await fetch('/api/solve_task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mflix-internal': 'true' },
        body: JSON.stringify({
          taskId,
          links: pendingLinks.map((l: any) => ({ id: l.id, name: l.name, link: l.link })),
          extractedBy: 'Server/Auto-Pilot',
        }),
      });

      if (solveRes.ok) {
        const solveData = await solveRes.json();
        const success = (solveData.done || 0) > 0;
        addAutoPilotLog(`${success ? '✅' : '⚠️'} Done: ${solveData.done} solved, ${solveData.errors} failed`, success ? 'success' : 'warn');
        await patchQueueStatus(item, success ? 'completed' : 'failed');
        await fetchTasks();
        return success;
      } else {
        addAutoPilotLog(`❌ solve_task failed: HTTP ${solveRes.status}`, 'error');
        await patchQueueStatus(item, 'failed', `HTTP ${solveRes.status}`);
        return false;
      }
    } catch (err: any) {
      addAutoPilotLog(`❌ Exception: ${err.message}`, 'error');
      await patchQueueStatus(item, 'failed', err.message);
      return false;
    }
  };

  const runAutoPilot = async () => {
    autoPilotLogRef.current = [];
    setAutoPilotLog([]);
    setAutoPilotProcessed(0);
    setCurrentQueueItem(null);
    setAutoPilotPhase('fetching');
    setAutoPilotStatusMsg('Connecting to Firebase queue...');
    addAutoPilotLog('🔌 Connecting to Firebase...', 'info');

    let pendingItems: QueueItem[] = [];
    try {
      const result = await fetchFirebaseQueue();
      pendingItems = result.pendingItems;
      setQueueStats(result.stats);
      addAutoPilotLog(`✅ ${result.stats.totalPending} pending, ${result.stats.totalCompleted} completed, ${result.stats.totalFailed} failed`, 'success');
    } catch (err: any) {
      addAutoPilotLog(`❌ Firebase fetch failed: ${err.message}`, 'error');
      setAutoPilotStatusMsg(`Connection failed: ${err.message}`);
      setAutoPilotPhase('stopped');
      autoPilotActiveRef.current = false;
      return;
    }

    if (pendingItems.length === 0) {
      addAutoPilotLog('✅ Queue is empty — nothing to process!', 'success');
      setAutoPilotStatusMsg('Queue is empty!');
      setAutoPilotPhase('done');
      autoPilotActiveRef.current = false;
      return;
    }

    setAutoPilotPhase('running');
    addAutoPilotLog(`🛡️ Server-side processing — safe to close browser!`, 'info');
    let processed = 0;

    for (let i = 0; i < pendingItems.length; i++) {
      if (!autoPilotActiveRef.current) {
        addAutoPilotLog('🛑 Stopped by user.', 'warn');
        setAutoPilotStatusMsg('Stopped by user.');
        setAutoPilotPhase('stopped');
        setCurrentQueueItem(null);
        break;
      }
      const item = pendingItems[i];
      setCurrentQueueItem(item);
      setUrl(item.url || '');
      setAutoPilotStatusMsg(`Processing ${i + 1}/${pendingItems.length}: ${item.title || item.url?.slice(0, 40) || item.id}`);
      addAutoPilotLog(`⚡ [${i + 1}/${pendingItems.length}] "${item.title || item.url?.slice(0, 50)}"`, 'info');

      const success = await processQueueItemAutoPilot(item);
      if (success) {
        processed++;
        setAutoPilotProcessed(processed);
        addAutoPilotLog(`✅ Done: "${item.title || item.id}"`, 'success');
      } else {
        addAutoPilotLog(`⚠️ Failed: "${item.title || item.id}"`, 'warn');
      }

      setQueueStats(prev => prev ? {
        ...prev,
        totalPending: Math.max(0, prev.totalPending - 1),
        totalCompleted: success ? prev.totalCompleted + 1 : prev.totalCompleted,
        totalFailed: !success ? prev.totalFailed + 1 : prev.totalFailed,
      } : prev);

      if (!autoPilotActiveRef.current) break;
      if (i < pendingItems.length - 1) {
        setAutoPilotStatusMsg(`✅ Done (${i + 1}/${pendingItems.length}) — Cooling down 3s...`);
        addAutoPilotLog('⏳ 3s cooldown...', 'info');
        await sleep(3000);
      }
    }

    if (autoPilotActiveRef.current) {
      addAutoPilotLog(`🎉 Complete! Processed ${processed}/${pendingItems.length} URLs.`, 'success');
      setAutoPilotStatusMsg(`Complete! Processed ${processed} of ${pendingItems.length} URLs.`);
      setAutoPilotPhase('done');
    }
    autoPilotActiveRef.current = false;
    setCurrentQueueItem(null);
    setUrl('');
  };

  const handleStartAutoPilot = () => { autoPilotActiveRef.current = true; runAutoPilot(); };
  const handleStopAutoPilot = () => {
    autoPilotActiveRef.current = false;
    setAutoPilotStatusMsg('Stopping after current item...');
    addAutoPilotLog('🛑 Stop requested...', 'warn');
  };
  const handleResetAutoPilot = () => {
    autoPilotActiveRef.current = false;
    setAutoPilotPhase('idle');
    setQueueStats(null);
    setCurrentQueueItem(null);
    setAutoPilotProcessed(0);
    setAutoPilotStatusMsg('');
    setAutoPilotLog([]);
    autoPilotLogRef.current = [];
    setShowQueuePreview(false);
    setShowAutoPilotLog(false);
  };
  const handleRefreshQueue = async () => {
    try {
      setAutoPilotStatusMsg('Refreshing queue...');
      const result = await fetchFirebaseQueue();
      setQueueStats(result.stats);
      setAutoPilotStatusMsg(`Refreshed — ${result.stats.totalPending} pending`);
      addAutoPilotLog(`🔄 Refreshed: ${result.stats.totalPending} pending`, 'info');
    } catch (err: any) { setAutoPilotStatusMsg(`Refresh failed: ${err.message}`); }
  };

  const isAutoPilotRunning = autoPilotPhase === 'running' || autoPilotPhase === 'fetching';

  // ─── Manual Process ───────────────────────────────────────────────────────────
  const startProcess = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    const normalizeUrl = (u: string) =>
      u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    const targetUrl = normalizeUrl(trimmedUrl);
    const existingTask = tasks.find(t => normalizeUrl(t.url) === targetUrl);
    if (existingTask) {
      const trueStatus = getTrueTaskStatus(existingTask, getEffectiveStats(existingTask));
      if (trueStatus === 'completed') {
        setError('✅ Yeh movie pehle se nikal chuki hai! Niche dekho.');
        setExpandedTask(existingTask.id); setActiveTab('completed'); setUrl(''); return;
      }
      if (trueStatus === 'processing') {
        setError('⏳ Yeh movie already process ho rahi hai!');
        setExpandedTask(existingTask.id); setActiveTab('processing'); setUrl(''); return;
      }
    }
    setIsConnecting(true); setError(null); setIsDone(false);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmedUrl }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setIsConnecting(false); setIsProcessing(true);
      await fetchTasks();
      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');
        completedLinksRef.current[data.taskId] = {};
        try {
          const taskRes = await fetch('/api/tasks');
          if (taskRes.ok) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) await startLiveStream(data.taskId, newTask.links);
          }
        } catch {}
      }
      setUrl(''); setIsProcessing(false); setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
      setIsConnecting(false); setIsProcessing(false);
    }
  };

  // ─── Task Actions ─────────────────────────────────────────────────────────────
  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingTaskId) return;
    setDeletingTaskId(taskId);
    try {
      const res = await fetch('/api/tasks', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!res.ok) throw new Error('Delete failed');
      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (expandedTask === taskId) setExpandedTask(null);
      delete completedLinksRef.current[taskId];
      delete streamEndedAtRef.current[taskId];
    } catch (err: any) { setError(`Delete failed: ${err.message}`); }
    finally { setDeletingTaskId(null); }
  };

  const handleRetryTask = async (task: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    if (retryingTaskId) return;
    setRetryingTaskId(task.id);
    try {
      await fetch('/api/tasks', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });
      delete completedLinksRef.current[task.id];
      delete streamEndedAtRef.current[task.id];
      const res = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: task.url }),
      });
      if (!res.ok) throw new Error('Server error');
      const data = await res.json();
      await fetchTasks();
      if (data.taskId) {
        setExpandedTask(data.taskId); setActiveTab('processing');
        try {
          const taskRes = await fetch('/api/tasks');
          if (taskRes.ok) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) await startLiveStream(data.taskId, newTask.links);
          }
        } catch {}
      }
    } catch (err: any) { setError(`Retry failed: ${err.message}`); }
    finally { setRetryingTaskId(null); }
  };

  const getEffectiveLinkData = (task: Task, linkIdx: number, link: any) => {
    const isLive = activeTaskId === task.id;
    const shield = completedLinksRef.current[task.id]?.[linkIdx];
    if (isLive && liveStatuses[linkIdx]) {
      return { logs: liveLogs[linkIdx] || [], finalLink: liveLinks[linkIdx] || null, status: liveStatuses[linkIdx] };
    }
    if (shield) {
      return { logs: shield.logs || [], finalLink: shield.finalLink || link.finalLink || null, status: shield.status };
    }
    return { logs: link.logs || [], finalLink: link.finalLink || null, status: link.status || 'processing' };
  };

  const getFilteredTasks = (): Task[] => {
    switch (activeTab) {
      case 'processing': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'processing');
      case 'completed': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'completed');
      case 'failed': return tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'failed');
      case 'history': return [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      default: return tasks;
    }
  };

  const filteredTasks = getFilteredTasks();
  const tabLabels: Record<TabType, string> = { home: 'Home', processing: 'Processing', completed: 'Completed', failed: 'Failed', history: 'History' };
  const totalInQueue = queueStats ? (queueStats.totalPending + autoPilotProcessed) : 0;
  const autoPilotProgress = totalInQueue > 0 ? Math.min(100, Math.round((autoPilotProcessed / totalInQueue) * 100)) : autoPilotPhase === 'done' ? 100 : 0;

  // ─── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto px-4 py-8 pb-28">

      {/* HEADER */}
      <header className="flex justify-between items-center mb-4">
        <div className="text-2xl font-bold bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
          <Bolt className="text-indigo-500 fill-indigo-500" />
          MFLIX PRO
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
            <PulseDot color={engineStatus?.signal === 'ONLINE' ? 'bg-emerald-400' : 'bg-rose-400'} />
            {engineStatus?.signal === 'ONLINE' ? 'LIVE ENGINE' : 'ENGINE OFFLINE'}
          </div>
          <a href="/admin" className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all" title="Admin Panel">
            <Settings className="w-4 h-4" />
          </a>
        </div>
      </header>

      {/* ENGINE STATUS BAR */}
      {engineStatus && (
        <div className={`mb-6 rounded-2xl border p-3 transition-all duration-500 ${
          engineStatus.signal === 'ONLINE'
            ? engineStatus.backgroundActive
              ? 'border-emerald-500/30 bg-gradient-to-r from-emerald-950/40 via-slate-900/60 to-emerald-950/40'
              : 'border-emerald-500/20 bg-emerald-950/20'
            : 'border-rose-500/20 bg-rose-950/20'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className={`p-1.5 rounded-lg ${engineStatus.signal === 'ONLINE' ? 'bg-emerald-500/20' : 'bg-rose-500/20'}`}>
                {engineStatus.signal === 'ONLINE'
                  ? <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  : <WifiOff className="w-3.5 h-3.5 text-rose-400" />}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${engineStatus.signal === 'ONLINE' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    GitHub Engine: {engineStatus.signal}
                  </span>
                  {engineStatus.backgroundActive && (
                    <span className="flex items-center gap-1 text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30">
                      <Activity className="w-2.5 h-2.5 animate-pulse" />BACKGROUND ACTIVE
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {engineStatus.timeSinceLastRun && (
                    <span className="text-[9px] text-slate-500 font-mono">Last ping: {engineStatus.timeSinceLastRun}</span>
                  )}
                  {engineStatus.pendingCount > 0 && (
                    <span className="text-[9px] text-amber-400 font-mono">{engineStatus.pendingCount} pending</span>
                  )}
                </div>
              </div>
            </div>
            {(engineStatus.backgroundActive || isAutoPilotRunning) && (
              <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1.5">
                <Shield className="w-3 h-3 text-emerald-400" />
                <span className="text-[9px] text-emerald-300 font-bold">Safe to close browser</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* HOME: URL Input + Auto-Pilot */}
      {activeTab === 'home' && (
        <section className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 mb-8 shadow-2xl">

          {/* URL Input */}
          <div className="relative mb-4">
            <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
            <input
              type="text" value={url} onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && startProcess()}
              placeholder="Paste Movie URL here..."
              className="w-full bg-black/40 border border-white/10 text-white pl-12 pr-4 py-4 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 transition-all font-sans"
            />
          </div>

          {/* Start Button */}
          <button
            onClick={startProcess}
            disabled={isConnecting || isProcessing || isDone || isAutoPilotRunning}
            className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 shadow-lg active:scale-95 ${
              isDone ? 'bg-emerald-500 text-white' :
              error ? 'bg-rose-500 text-white' :
              'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:opacity-70'
            }`}
          >
            {isConnecting ? <><Loader2 className="w-5 h-5 animate-spin" />CONNECTING...</> :
             isProcessing ? <><RotateCcw className="w-5 h-5 animate-spin" />PROCESSING LIVE...</> :
             isDone ? <><CircleCheck className="w-5 h-5" />ALL DONE ✅</> :
             error ? <><AlertTriangle className="w-5 h-5" />ERROR</> :
             <><Rocket className="w-5 h-5" />START ENGINE</>}
          </button>

          {/* Error / Info Banner */}
          {error && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-emerald-300">Dismiss</button>
            </motion.div>
          )}

          {/* AUTO-PILOT DASHBOARD */}
          <div className="mt-5">
            <div className={`relative overflow-hidden rounded-2xl border transition-all duration-500 ${
              isAutoPilotRunning
                ? 'border-violet-500/50 bg-gradient-to-br from-violet-950/60 via-slate-900/80 to-indigo-950/60 shadow-lg shadow-violet-500/10'
                : autoPilotPhase === 'done'
                  ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-950/40 via-slate-900/80 to-slate-900/60'
                  : autoPilotPhase === 'stopped'
                    ? 'border-rose-500/30 bg-slate-900/60'
                    : 'border-white/10 bg-black/20'
            }`}>
              {/* Scan line animation when running */}
              {isAutoPilotRunning && (
                <motion.div className="absolute inset-0 pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-violet-500/5 to-transparent animate-pulse" />
                  <motion.div
                    className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent"
                    animate={{ top: ['0%', '100%'] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                  />
                </motion.div>
              )}

              <div className="relative p-4">
                {/* Header row */}
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`p-2 rounded-xl transition-all ${isAutoPilotRunning ? 'bg-violet-500/20 ring-1 ring-violet-500/40' : 'bg-white/5'}`}>
                      {isAutoPilotRunning
                        ? <Cpu className="w-4 h-4 text-violet-300 animate-pulse" />
                        : autoPilotPhase === 'done'
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          : <Bot className="w-4 h-4 text-slate-400" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white tracking-wide">AUTO-PILOT</span>
                        {isAutoPilotRunning && (
                          <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-500/25 text-violet-300 ring-1 ring-violet-500/40 uppercase tracking-wider">
                            <PulseDot color="bg-violet-400" />LIVE
                          </span>
                        )}
                        {autoPilotPhase === 'done' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 uppercase">DONE</span>}
                        {autoPilotPhase === 'stopped' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 uppercase">STOPPED</span>}
                      </div>
                      <p className="text-[10px] text-slate-500 mt-0.5">Server-side processor — safe to close browser</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!isAutoPilotRunning && autoPilotPhase !== 'idle' && (
                      <button onClick={handleRefreshQueue} className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all">
                        <RefreshCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(autoPilotPhase === 'done' || autoPilotPhase === 'stopped') && (
                      <button onClick={handleResetAutoPilot} className="p-2 rounded-xl bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(autoPilotPhase === 'idle' || autoPilotPhase === 'done' || autoPilotPhase === 'stopped') ? (
                      <button onClick={handleStartAutoPilot} disabled={isConnecting || isProcessing}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm bg-violet-600 hover:bg-violet-500 text-white transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-violet-500/20">
                        <Play className="w-4 h-4" />
                        {autoPilotPhase === 'idle' ? 'Start' : 'Restart'}
                      </button>
                    ) : (
                      <button onClick={handleStopAutoPilot}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 transition-all active:scale-95">
                        <Pause className="w-4 h-4" />Stop
                      </button>
                    )}
                  </div>
                </div>

                {/* Status message */}
                <AnimatePresence mode="wait">
                  {autoPilotStatusMsg && (
                    <motion.div
                      key={autoPilotStatusMsg.slice(0, 30)}
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-center gap-2 bg-black/30 rounded-xl px-3 py-2.5 mb-3"
                    >
                      {isAutoPilotRunning && <Zap className="w-3.5 h-3.5 text-violet-400 flex-shrink-0 animate-pulse" />}
                      {autoPilotPhase === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
                      {autoPilotPhase === 'stopped' && <AlertCircle className="w-3.5 h-3.5 text-rose-400 flex-shrink-0" />}
                      <p className="text-[11px] text-slate-200 font-mono truncate">{autoPilotStatusMsg}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Currently Processing Item */}
                <AnimatePresence>
                  {currentQueueItem && isAutoPilotRunning && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
                      className="bg-violet-950/50 border border-violet-500/25 rounded-xl p-3 mb-3"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Radio className="w-3 h-3 text-violet-400 animate-pulse" />
                        <span className="text-[9px] font-bold text-violet-400 uppercase tracking-widest">Now Processing (Server-Side)</span>
                      </div>
                      <p className="text-xs font-bold text-white truncate">{currentQueueItem.title || 'Untitled'}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-[10px] text-slate-500 font-mono truncate flex-1">{currentQueueItem.url?.slice(0, 55)}...</p>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold flex-shrink-0 ${currentQueueItem.type === 'webseries' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-amber-500/20 text-amber-400'}`}>
                          {currentQueueItem.type === 'webseries'
                            ? <><Tv2 className="w-2.5 h-2.5 inline mr-0.5" />Series</>
                            : <><Film className="w-2.5 h-2.5 inline mr-0.5" />Movie</>}
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Stats Grid */}
                <AnimatePresence>
                  {queueStats && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-3">
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: 'Total', value: queueStats.totalAll, color: 'text-slate-300', bg: 'bg-white/5', border: 'border-white/10' },
                          { label: 'Pending', value: queueStats.totalPending, color: 'text-amber-400', bg: 'bg-amber-500/5', border: 'border-amber-500/15' },
                          { label: 'Done', value: queueStats.totalCompleted + autoPilotProcessed, color: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/15' },
                          { label: 'Failed', value: queueStats.totalFailed, color: 'text-rose-400', bg: 'bg-rose-500/5', border: 'border-rose-500/15' },
                        ].map(stat => (
                          <div key={stat.label} className={`${stat.bg} border ${stat.border} rounded-xl p-2 text-center`}>
                            <p className="text-[9px] uppercase font-bold text-slate-500 mb-0.5">{stat.label}</p>
                            <motion.p key={stat.value} initial={{ scale: 1.2, opacity: 0.5 }} animate={{ scale: 1, opacity: 1 }} className={`text-base font-bold ${stat.color}`}>{stat.value}</motion.p>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Progress Bar */}
                <AnimatePresence>
                  {queueStats && (autoPilotPhase === 'running' || autoPilotPhase === 'done') && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-3">
                      <div className="flex items-center justify-between text-[10px] font-mono mb-1.5">
                        <span className="flex items-center gap-1 text-slate-400">
                          <TrendingUp className="w-3 h-3" />{autoPilotProcessed} processed
                        </span>
                        <span className={`font-bold ${autoPilotProgress === 100 ? 'text-emerald-400' : 'text-violet-400'}`}>{autoPilotProgress}%</span>
                      </div>
                      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                        <motion.div
                          className={`h-full rounded-full ${autoPilotProgress === 100 ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : 'bg-gradient-to-r from-violet-600 via-indigo-500 to-violet-400'}`}
                          initial={{ width: '0%' }} animate={{ width: `${autoPilotProgress}%` }} transition={{ duration: 0.5, ease: 'easeOut' }}
                        />
                      </div>
                      {isAutoPilotRunning && (
                        <div className="flex justify-between text-[9px] text-slate-600 mt-1 font-mono">
                          <span>Processing on server...</span>
                          <span>{Math.max(0, queueStats.totalPending - 1)} remaining</span>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Queue Preview */}
                {queueStats && queueStats.pendingItems.length > 0 && (
                  <div className="border-t border-white/5 pt-3">
                    <button onClick={() => setShowQueuePreview(v => !v)}
                      className="w-full flex items-center justify-between text-[11px] text-slate-400 hover:text-slate-200 transition-colors">
                      <span className="flex items-center gap-1.5">
                        <Eye className="w-3.5 h-3.5" />Queue Preview
                        <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[9px] font-bold">{queueStats.pendingItems.length} pending</span>
                      </span>
                      {showQueuePreview ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <AnimatePresence>
                      {showQueuePreview && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                          <div className="mt-2 space-y-1.5 max-h-52 overflow-y-auto pr-1">
                            {queueStats.pendingItems.map((item, idx) => {
                              const isCurrent = currentQueueItem?.id === item.id;
                              const isDoneItem = idx < autoPilotProcessed;
                              return (
                                <motion.div key={item.id}
                                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(idx * 0.03, 0.5) }}
                                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] transition-all ${
                                    isCurrent ? 'bg-violet-500/15 border border-violet-500/30' :
                                    isDoneItem ? 'bg-emerald-500/5 opacity-50' : 'bg-white/[0.03] hover:bg-white/5'
                                  }`}>
                                  <span className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold bg-white/10 text-slate-400">
                                    {isDoneItem ? '✓' : isCurrent ? <Loader2 className="w-2.5 h-2.5 animate-spin text-violet-400" /> : idx + 1}
                                  </span>
                                  <span className={`flex-shrink-0 text-[9px] px-1 py-0.5 rounded font-bold ${item.type === 'webseries' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-amber-500/20 text-amber-400'}`}>
                                    {item.type === 'webseries' ? 'S' : 'M'}
                                  </span>
                                  <span className={`truncate flex-1 ${isCurrent ? 'text-violet-200 font-medium' : 'text-slate-400'}`}>
                                    {item.title || item.url?.replace(/^https?:\/\//, '').slice(0, 40) || item.id}
                                  </span>
                                  {isCurrent && <Radio className="w-3 h-3 text-violet-400 animate-pulse flex-shrink-0" />}
                                </motion.div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Activity Log */}
                {autoPilotLog.length > 0 && (
                  <div className={`${queueStats && queueStats.pendingItems.length > 0 ? 'mt-2' : 'border-t border-white/5 pt-3'}`}>
                    <button onClick={() => setShowAutoPilotLog(v => !v)}
                      className="w-full flex items-center justify-between text-[11px] text-slate-400 hover:text-slate-200 transition-colors">
                      <span className="flex items-center gap-1.5">
                        <ListVideo className="w-3.5 h-3.5" />Activity Log
                        <span className="px-1.5 py-0.5 rounded-full bg-slate-700/60 text-slate-400 text-[9px]">{autoPilotLog.length}</span>
                      </span>
                      {showAutoPilotLog ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <AnimatePresence>
                      {showAutoPilotLog && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                          <div className="mt-2 bg-black/40 rounded-xl p-3 max-h-40 overflow-y-auto space-y-1 font-mono scrollbar-hide">
                            {autoPilotLog.map((entry, idx) => (
                              <div key={idx} className={`text-[10px] flex items-start gap-1.5 ${
                                entry.type === 'success' ? 'text-emerald-400' :
                                entry.type === 'error' ? 'text-rose-400' :
                                entry.type === 'warn' ? 'text-amber-400' : 'text-slate-400'
                              }`}>
                                <span className="opacity-40 flex-shrink-0">{String(autoPilotLog.length - idx).padStart(2, '0')}</span>
                                <span>{entry.msg}</span>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Error for non-home tabs */}
      {activeTab !== 'home' && error && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-emerald-300">Dismiss</button>
        </motion.div>
      )}

      {/* Tab Header */}
      <div className="mb-6 flex items-center gap-2 text-slate-400">
        {activeTab === 'processing' ? <Loader2 className="w-5 h-5 animate-spin" /> :
         activeTab === 'completed' ? <CheckCircle2 className="w-5 h-5" /> :
         activeTab === 'failed' ? <XCircle className="w-5 h-5" /> :
         <History className="w-5 h-5" />}
        <h3 className="font-bold uppercase tracking-wider text-sm">
          {activeTab === 'home' ? 'Recent Tasks' : `${tabLabels[activeTab]} Tasks`}
        </h3>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Tasks List */}
      <div className="space-y-4">
        {filteredTasks.map(task => {
          const stats = getEffectiveStats(task);
          const trueStatus = getTrueTaskStatus(task, stats);
          return (
            <div key={task.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all hover:bg-white/[0.07]">
              {/* Task Header */}
              <div className="p-4 flex items-center gap-4 cursor-pointer" onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}>
                {/* Poster thumbnail */}
                <div className="w-12 h-16 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/10">
                  {task.preview?.posterUrl ? (
                    <>
                      <img src={task.preview.posterUrl} alt={task.preview.title || 'Movie'} className="w-full h-full object-cover"
                        onError={e => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          const next = (e.target as HTMLImageElement).nextElementSibling;
                          if (next) (next as HTMLElement).style.display = 'flex';
                        }} />
                      <div style={{ display: 'none' }} className="w-full h-full items-center justify-center">
                        <Film className="w-5 h-5 text-indigo-400" />
                      </div>
                    </>
                  ) : (
                    <Film className="w-5 h-5 text-indigo-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-sm text-white truncate">{task.preview?.title || 'Processing...'}</h4>
                  <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{task.url}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                      trueStatus === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                      trueStatus === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                      'bg-indigo-500/20 text-indigo-400 animate-pulse'
                    }`}>
                      {trueStatus === 'processing' && activeTaskId === task.id ? '⚡ LIVE' : trueStatus}
                    </span>
                    {task.extractedBy && (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold flex items-center gap-1 ${
                        task.extractedBy === 'Server/Auto-Pilot'
                          ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/30'
                          : 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/25'
                      }`}>
                        {task.extractedBy === 'Server/Auto-Pilot'
                          ? <><Cloud className="w-2.5 h-2.5" />Auto-Pilot</>
                          : <><Smartphone className="w-2.5 h-2.5" />Live</>}
                      </span>
                    )}
                    <span className="text-slate-600 text-[10px]">{formatTime12h(task.createdAt)}</span>
                    {stats.total > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono">{stats.total} links</span>
                        {stats.done > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">✓{stats.done}</span>}
                        {stats.failed > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-mono">✗{stats.failed}</span>}
                        {stats.pending > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">⏳{stats.pending}</span>}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {trueStatus === 'failed' && (
                    <button onClick={e => handleRetryTask(task, e)} disabled={retryingTaskId === task.id}
                      className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50">
                      {retryingTaskId === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    </button>
                  )}
                  <button onClick={e => handleDeleteTask(task.id, e)} disabled={deletingTaskId === task.id}
                    className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all disabled:opacity-50">
                    {deletingTaskId === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                  {expandedTask === task.id ? <ChevronDown className="w-5 h-5 text-slate-500" /> : <ChevronRight className="w-5 h-5 text-slate-500" />}
                </div>
              </div>

              {/* Expanded Task Content */}
              <AnimatePresence>
                {expandedTask === task.id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    className="border-t border-white/5 bg-black/20">
                    {/* Blurred banner */}
                    {task.preview?.posterUrl && (
                      <div className="relative h-32 overflow-hidden">
                        <img src={task.preview.posterUrl} alt={task.preview.title || ''} className="w-full h-full object-cover opacity-30 blur-sm" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-transparent" />
                        <div className="absolute bottom-3 left-4 right-4">
                          <h3 className="text-lg font-bold text-white truncate">{task.preview.title}</h3>
                        </div>
                      </div>
                    )}
                    <div className="p-4">
                      {/* Stats row */}
                      {stats.total > 0 && (
                        <div className="grid grid-cols-4 gap-2 mb-4">
                          {[
                            { label: 'Total', value: stats.total, color: 'text-white', bg: 'bg-slate-800/50 border-white/5' },
                            { label: 'Done', value: stats.done, color: 'text-emerald-400', bg: 'bg-emerald-500/5 border-emerald-500/10' },
                            { label: 'Failed', value: stats.failed, color: 'text-rose-400', bg: 'bg-rose-500/5 border-rose-500/10' },
                            { label: 'Pending', value: stats.pending, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/10' },
                          ].map(s => (
                            <div key={s.label} className={`border rounded-lg p-2 text-center ${s.bg}`}>
                              <p className={`text-[10px] uppercase font-bold opacity-60 ${s.color}`}>{s.label}</p>
                              <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Metadata */}
                      {task.metadata && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Sparkles className="w-3 h-3" />Highest Quality
                            </label>
                            <p className="text-sm font-bold text-indigo-400">{task.metadata.quality || 'Unknown'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Globe className="w-3 h-3" />Languages
                            </label>
                            <p className="text-sm font-bold text-emerald-400">{task.metadata.languages || 'Not Specified'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Volume2 className="w-3 h-3" />Audio
                            </label>
                            <p className="text-sm font-bold text-amber-400">{task.metadata.audioLabel || 'Unknown'}</p>
                          </div>
                        </div>
                      )}

                      {/* Links */}
                      <div className="space-y-3">
                        {task.links.map((link: any, idx: number) => {
                          const eff = getEffectiveLinkData(task, idx, link);
                          return (
                            <LinkCard key={idx} id={idx} name={link.name} logs={eff.logs}
                              finalLink={eff.finalLink} status={eff.status as any} />
                          );
                        })}
                        {task.links.length === 0 && (
                          <div className="flex flex-col items-center py-8 text-slate-400">
                            <Loader2 className="w-8 h-8 animate-spin mb-2" />
                            <p className="text-sm">Scraping in progress...</p>
                            <p className="text-xs opacity-50">Server is processing — safe to close browser.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {filteredTasks.length === 0 && (
          <div className="text-center py-12 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
            <Rocket className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="font-medium">{activeTab === 'home' ? 'No tasks yet. Submit a URL to start!' : `No ${tabLabels[activeTab].toLowerCase()} tasks.`}</p>
          </div>
        )}
      </div>

      {/* BOTTOM NAV */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-t border-white/10">
        <div className="max-w-2xl mx-auto flex items-stretch justify-around">
          {([
            { key: 'home' as TabType, icon: Home, label: 'Home' },
            { key: 'processing' as TabType, icon: Clock, label: 'Processing' },
            { key: 'completed' as TabType, icon: CheckCircle2, label: 'Completed' },
            { key: 'failed' as TabType, icon: XCircle, label: 'Failed' },
            { key: 'history' as TabType, icon: History, label: 'History' },
          ]).map(({ key, icon: Icon, label }) => {
            const isActive = activeTab === key;
            const count =
              key === 'processing' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'processing').length :
              key === 'completed' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'completed').length :
              key === 'failed' ? tasks.filter(t => getTrueTaskStatus(t, getEffectiveStats(t)) === 'failed').length :
              key === 'history' ? tasks.length : 0;
            return (
              <button key={key} onClick={() => setActiveTab(key)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-3 px-1 transition-all relative ${isActive ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}>
                {isActive && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-indigo-500 rounded-full" />}
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {count > 0 && key !== 'home' && (
                    <span className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                      key === 'failed' ? 'bg-rose-500 text-white' :
                      key === 'processing' ? 'bg-indigo-500 text-white' :
                      key === 'completed' ? 'bg-emerald-500 text-white' :
                      'bg-slate-600 text-white'
                    }`}>{count}</span>
                  )}
                </div>
                <span className="text-[10px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
