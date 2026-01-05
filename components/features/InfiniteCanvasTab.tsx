
import { GoogleGenAI } from "@google/genai";
import React, { DragEvent, MouseEvent, TouchEvent, WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ensureHttps, generateClientId, getHistory, getImageUrl, getLogs, interruptPrompt, parseConsoleProgress, preloadImage, queuePrompt, uploadImage
} from '../../services/api';
import { generateEditWorkflow, generateFluxWorkflow, generateSdxlWorkflow, generateUpscaleWorkflow } from '../../services/workflows';
import Button from '../ui/Button';
import ImageEditor from './ImageEditor';

// --- IndexedDB Persistence ---
const IDB_NAME = 'StudioNeuralDB';
const IDB_STORE = 'projects';

const openDB = () => {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 2);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveProject = async (items: CanvasItem[]) => {
  const db = await openDB();
  
  // Recursively convert blob URLs to Blob objects for storage
  const processItem = async (val: any): Promise<any> => {
    if (typeof val === 'string' && val.startsWith('blob:')) {
      try {
        const res = await fetch(val);
        const blob = await res.blob();
        return blob;
      } catch (e) {
        console.warn("Failed to persist blob (likely revoked):", val);
        return val;
      }
    }
    if (Array.isArray(val)) {
      return Promise.all(val.map(processItem));
    }
    if (val !== null && typeof val === 'object' && !(val instanceof Blob)) {
      const newObj: any = {};
      for (const k in val) {
        newObj[k] = await processItem(val[k]);
      }
      return newObj;
    }
    return val;
  };

  const serialized = await processItem(items);

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(serialized, 'current_workspace');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const loadProject = async (): Promise<CanvasItem[] | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get('current_workspace');
    req.onsuccess = () => {
      const val = req.result;
      if (!val) {
        resolve(null);
        return;
      }

      // Recursively convert stored Blobs back to blob URLs
      const processItem = (v: any): any => {
        if (v instanceof Blob) {
          return URL.createObjectURL(v);
        }
        if (Array.isArray(v)) {
          return v.map(processItem);
        }
        if (v !== null && typeof v === 'object') {
          const newObj: any = {};
          for (const k in v) {
            newObj[k] = processItem(v[k]);
          }
          return newObj;
        }
        return v;
      };

      resolve(processItem(val));
    };
    req.onerror = () => reject(req.error);
  });
};

// --- Constants ---
const SIZE_PRESETS = [
  { label: 'Square (1:1)', w: 1024, h: 1024 },
  { label: 'Landscape (16:9)', w: 1280, h: 720 },
  { label: 'Portrait (9:16)', w: 720, h: 1280 },
  { label: 'Tall (8:16)', w: 512, h: 1024 },
  { label: 'Classic (4:3)', w: 1152, h: 864 },
];

const CLIPBOARD_MARKER = "COMFY_UI_PRO_INTERNAL_NODES";
const GROUP_PADDING = 60;
const AUTO_LAYOUT_GAP = 60;

// --- Helper: File to DataURL ---
const fileToDataURL = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// --- Helper: Line Intersection Math ---
const checkLineIntersection = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number) => {
  const den = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (den === 0) return false;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / den;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / den;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
};

// --- Optimized Video Player Component ---
const VideoPlayer = React.memo(({ src, isActive }: { src: string; isActive: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.15); // Default to 15% volume
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Reset error state on new src
    setError(null);

    // Initialize volume immediately when src loads
    video.volume = 0.15; 
    video.muted = false;

    const updateState = () => {
        setCurrentTime(video.currentTime);
        if (video.duration) {
            setDuration(video.duration);
            setProgress((video.currentTime / video.duration) * 100);
        }
        setIsPlaying(!video.paused);
        setVolume(video.volume);
        setIsMuted(video.muted);
    };

    const handleError = (e: Event) => {
      if (video.error) {
        console.warn("Video Playback Error:", video.error, src);
        setError("Media Stream Interrupted");
      }
    };

    video.addEventListener('timeupdate', updateState);
    video.addEventListener('play', updateState);
    video.addEventListener('pause', updateState);
    video.addEventListener('volumechange', updateState);
    video.addEventListener('loadedmetadata', updateState);
    video.addEventListener('error', handleError);
    
    // Autoplay logic if visible
    if (isVisible) {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          setIsPlaying(false);
          // Auto-play might be blocked due to unmuted audio logic in browsers
          console.log("Autoplay blocked (likely waiting for interaction):", err);
        });
      }
    } else {
      video.pause();
    }

    return () => {
        video.removeEventListener('timeupdate', updateState);
        video.removeEventListener('play', updateState);
        video.removeEventListener('pause', updateState);
        video.removeEventListener('volumechange', updateState);
        video.removeEventListener('loadedmetadata', updateState);
        video.removeEventListener('error', handleError);
    };
  }, [src, isVisible]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (video) {
        if (video.paused) video.play();
        else video.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      const video = videoRef.current;
      if (video && video.duration) {
          const newTime = (parseFloat(e.target.value) / 100) * video.duration;
          video.currentTime = newTime;
          setProgress(parseFloat(e.target.value));
      }
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      const video = videoRef.current;
      const newVol = parseFloat(e.target.value);
      if (video) {
          video.volume = newVol;
          video.muted = newVol === 0;
      }
  };

  const toggleMute = (e: React.MouseEvent) => {
      e.stopPropagation();
      const video = videoRef.current;
      if (video) {
          video.muted = !video.muted;
      }
  };

  const formatTime = (t: number) => {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
  };

  if (error) {
    return (
      <div className="w-full h-full bg-slate-950/50 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center gap-4 border border-white/10">
        <div className="w-12 h-12 rounded-full bg-rose-500/20 flex items-center justify-center text-rose-500 mb-2 ring-1 ring-rose-500/30">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <span className="text-[10px] font-black text-rose-400 uppercase tracking-[0.2em]">Signal Lost</span>
      </div>
    );
  }

  return (
      <div ref={containerRef} className="relative w-full h-full bg-black/5 group/player overflow-hidden contain-strict">
          <video 
             ref={videoRef}
             src={src}
             className="w-full h-full object-contain pointer-events-auto transform-gpu"
             loop
             playsInline
             // Removed muted prop to allow sound
             onClick={togglePlay}
          />
          
          <div 
            className={`absolute bottom-6 left-6 right-6 p-3 bg-black/40 backdrop-blur-xl rounded-2xl border border-white/10 transition-all duration-500 z-30 flex items-center gap-3 shadow-2xl ${isActive || !isPlaying ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 group-hover/player:opacity-100 group-hover/player:translate-y-0'}`}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
              <button onClick={togglePlay} className="text-white hover:text-cyan-400 transition-colors p-2 rounded-xl hover:bg-white/10">
                  {isPlaying ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
                  ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  )}
              </button>
              
              <div className="flex-1 h-1 bg-white/20 rounded-full cursor-pointer relative group/slider">
                  <div className="absolute inset-0 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-cyan-400 to-blue-500" style={{ width: `${progress}%` }} />
                  </div>
                  <input 
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    value={progress}
                    onChange={handleSeek}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="absolute h-2.5 w-2.5 bg-white rounded-full shadow-lg top-1/2 -translate-y-1/2 pointer-events-none opacity-0 group-hover/slider:opacity-100 transition-opacity" style={{ left: `${progress}%` }} />
              </div>

              <div className="flex items-center gap-2 group/vol">
                  <button onClick={toggleMute} className="text-white hover:text-cyan-400 transition-colors p-1.5 rounded-lg hover:bg-white/10">
                      {isMuted || volume === 0 ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                      ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                      )}
                  </button>
                  <div className="w-0 overflow-hidden group-hover/vol:w-16 transition-all duration-300">
                      <input 
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={isMuted ? 0 : volume}
                        onChange={handleVolume}
                        className="w-16 h-1 bg-white/20 rounded-full appearance-none accent-white cursor-pointer"
                      />
                  </div>
              </div>
              
              <span className="text-[9px] font-mono font-bold text-white/70 tabular-nums tracking-wider min-w-[55px] text-right">
                  {formatTime(currentTime)}
              </span>
          </div>
      </div>
  );
});

// --- Types ---
type ItemType = 'image' | 'generator' | 'editor' | 'group' | 'video';
type ModelType = 'flux' | 'sdxl' | 'nano-banana-pro' | 'nano-banana-fast';
type VideoModelType = 'veo3.1-fast' | 'veo3.1-pro' | 'sora2';
type EditMode = 'qwen' | 'nano-banana-pro' | 'nano-banana-fast';
type VideoDuration = '4s' | '6s' | '8s' | '10s' | '15s';
type VideoResolution = '720p' | '1080p';

interface Notification {
  message: string;
  type: 'error' | 'success' | 'info' | 'warning';
}

interface HistoryEntry {
  src: string;
  prompt: string;
  steps?: number;
  cfg?: number;
  model?: string;
  editMode?: EditMode;
  timestamp?: number;
}

interface BaseItem {
  id: string;
  type: ItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  parentIds?: string[];
  history: HistoryEntry[]; 
  historyIndex: number;
  groupId?: string; 
}

interface ImageItem extends BaseItem {
  type: 'image';
  src: string;
  editPrompt?: string;
  editMode?: EditMode;
  isEditing?: boolean;
  editProgress?: number;
  isUpscaling?: boolean;
  upscaleProgress?: number;
  isRegenerating?: boolean;
  isFragmenting?: boolean;
}

interface GeneratorItem extends BaseItem {
  type: 'generator';
  data: {
    model: ModelType;
    prompt: string;
    negPrompt: string; 
    width: number;
    height: number;
    steps: number;
    cfg: number;
    isGenerating: boolean;
    progress: number;
    resultImage?: string;
    mode: 'input' | 'result';
    editPrompt?: string;
    editMode?: EditMode;
    isEditing?: boolean;
    editProgress?: number;
    isUpscaling?: boolean;
    upscaleProgress?: number;
    useLora?: boolean; 
    referenceImages?: string[]; 
    isTranslating?: boolean;
    isFragmenting?: boolean;
  };
}

interface VideoGeneratorItem extends BaseItem {
  type: 'video';
  data: {
    model: VideoModelType;
    prompt: string;
    isGenerating: boolean;
    progress: number;
    resultVideo?: string;
    mode: 'input' | 'result';
    aspectRatio: '16:9' | '9:16';
    duration: VideoDuration;
    resolution: VideoResolution;
    firstFrameUrl?: string;
    lastFrameUrl?: string;
    referenceImages?: string[];
    isTranslating?: boolean;
    isEditing?: boolean;
    isUpscaling?: boolean;
    isFragmenting?: boolean;
  };
}

interface EditorItem extends BaseItem {
  type: 'editor';
  data: {
    targetId: string | null;
    prompt: string;
    steps: number;
    cfg: number;
    isGenerating: boolean;
    progress: number;
  };
}

interface GroupItem extends BaseItem {
  type: 'group';
  childIds: string[];
  isCollapsed: boolean;
  title: string;
  originalBounds?: { w: number; h: number };
}

type CanvasItem = ImageItem | GeneratorItem | EditorItem | GroupItem | VideoGeneratorItem;

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

interface InfiniteCanvasTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

interface SelectionBox {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface ResizeState {
    id: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startSnapshot: CanvasItem[]; 
}

interface Point { x: number; y: number; }

// --- Helpers ---
const isVideoUrl = (url: string) => url.toLowerCase().match(/\.(mp4|webm|mov|ogg)$/) || url.startsWith('data:video') || url.includes('/video/') || url.startsWith('blob:');

const MemoNode = React.memo(({ 
  item, 
  isActive, 
  isSelected, 
  isLinkingSource,
  onMouseDown, 
  onTouchStart,
  renderContent,
  isDragging,
  isHidden
}: { 
  item: CanvasItem, 
  isActive: boolean, 
  isSelected: boolean,
  isLinkingSource: boolean,
  onMouseDown: (e: MouseEvent, id: string) => void,
  onTouchStart: (e: TouchEvent, id: string) => void,
  renderContent: (item: CanvasItem) => React.ReactNode,
  isDragging: boolean,
  isHidden: boolean
}) => {
  if (isHidden) return null;
  return (
    <div 
      className={`absolute group rounded-[48px] contain-layout ${isLinkingSource ? 'ring-2 ring-amber-400 shadow-premium z-30' : isSelected ? 'selection-active z-20' : isActive ? 'shadow-premium z-10' : 'shadow-soft'} ${isDragging ? 'cursor-grabbing select-none' : 'cursor-default'}`} 
      style={{ 
        width: item.width, 
        height: item.height, 
        zIndex: item.zIndex,
        transform: `translate3d(${item.x}px, ${item.y}px, 0)`,
        transition: isDragging ? 'none' : 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.4s ease, ring 0.3s ease',
        willChange: 'transform',
        top: 0,
        left: 0
      }} 
      onMouseDown={(e) => onMouseDown(e, item.id)} 
      onTouchStart={(e) => onTouchStart(e, item.id)}
    >
      {isLinkingSource && (
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-amber-500 text-white text-[10px] font-black px-4 py-1.5 rounded-full shadow-lg animate-bounce z-[60] uppercase tracking-widest whitespace-nowrap">
          Linking Source
        </div>
      )}
      {renderContent(item)}
    </div>
  );
});

const InfiniteCanvasTab: React.FC<InfiniteCanvasTabProps> = ({ serverUrl, setServerUrl }) => {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [undoStack, setUndoStack] = useState<CanvasItem[][]>([]);
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [activeItemId, setActiveItemId] = useState<string | null>(null); 
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); 
  const [activeSizeMenuId, setActiveSizeMenuId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [clipboard, setClipboard] = useState<CanvasItem[]>([]);
  const [showConnections, setShowConnections] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const dragSnapshotRef = useRef<{ items: { id: string; x: number; y: number }[]; mouse: { x: number; y: number } } | null>(null);

  const [dragMode, setDragMode] = useState<'canvas' | 'item' | 'selection' | 'cutting'>('canvas');
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [globalHistory, setGlobalHistory] = useState<HistoryEntry[]>([]);
  const [pickingRefForNodeId, setPickingRefForNodeId] = useState<string | null>(null);
  const [isCanvasPicking, setIsCanvasPicking] = useState(false);
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);
  const [cutTrail, setCutTrail] = useState<Point[]>([]);

  const abortedNodeIds = useRef<Set<string>>(new Set());

  const mousePosRef = useRef({ x: 0, y: 0 });
  const lastPinchDistRef = useRef<number | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; dims?: { w: number; h: number } } | null>(null);
  const [editingImage, setEditingImage] = useState<{ id: string; src: string; originalSrc: string } | null>(null);
  const [topZ, setTopZ] = useState(10);
  const [copyFeedbackId, setCopyFeedbackId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const notifyTimeoutRef = useRef<number | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);

  const showNotification = useCallback((message: string, type: 'error' | 'success' | 'info' | 'warning' = 'error') => {
    if (notifyTimeoutRef.current) window.clearTimeout(notifyTimeoutRef.current);
    setNotification({ message, type });
    notifyTimeoutRef.current = window.setTimeout(() => setNotification(null), 3000);
  }, []);

  const recordHistory = useCallback(() => {
    setUndoStack(prev => [JSON.parse(JSON.stringify(items)), ...prev].slice(0, 50));
  }, [items]);

  const resetView = useCallback(() => {
    setView({ x: 0, y: 0, scale: 1 });
    showNotification("View Reset", "info");
  }, [showNotification]);

  // --- Persistence: Load from IndexedDB ---
  useEffect(() => {
    const init = async () => {
      try {
        const loaded = await loadProject();
        if (loaded && Array.isArray(loaded)) {
          setItems(loaded);
          const maxZ = Math.max(...loaded.map(i => i.zIndex), 10);
          setTopZ(maxZ);
          console.log("Neural Archive Synchronized via IndexedDB.");
        }
      } catch (e) {
        console.error("Failed to load project from IndexedDB:", e);
        showNotification("Failed to load previous session", "error");
      }
    };
    init();
  }, []);

  // --- Debounced Persistence to IndexedDB ---
  useEffect(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        await saveProject(items);
      } catch (e) {
        console.warn("Failed to persist to IndexedDB:", e);
      }
    }, 2000);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [items]);

  const clearWorkspace = useCallback(async () => {
    if (confirm("Neural Purge Confirmation: Wipe all assets from current workspace?")) {
      recordHistory();
      setItems([]);
      setSelectedIds(new Set());
      setActiveItemId(null);
      await saveProject([]); // Clear DB
      resetView();
      showNotification("Neural Workspace Purged", "warning");
    }
  }, [recordHistory, resetView, showNotification]);

  const exportProjectFile = useCallback(() => {
    // Note: This exports blob URLs which are not portable.
    // For a real app, you'd convert blobs to base64 here.
    const data = JSON.stringify(items, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `studio-project-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showNotification("Project exported to disk", "success");
  }, [items, showNotification]);

  const importProjectFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            recordHistory();
            setItems(parsed);
            const maxZ = Math.max(...parsed.map(i => i.zIndex), 10);
            setTopZ(maxZ);
            showNotification("Project restored from file", "success");
            setShowHistoryPanel(false);
          }
        } catch (err) {
          showNotification("Failed to parse project file", "error");
        }
      };
      reader.readAsText(e.target.files[0]);
    }
  }, [recordHistory, showNotification]);

  // ... (keeping other helper functions like arrangeSelectedVertically, handleWheelEvent, etc. unchanged for brevity but they are implicitly included)
  const arrangeSelectedVertically = useCallback(() => {
    if (selectedIds.size < 2) { showNotification("Select multiple items to align", "info"); return; }
    recordHistory();
    setItems(prev => {
      const selectedItems = prev.filter(i => selectedIds.has(i.id)).sort((a, b) => a.y - b.y);
      const firstItem = selectedItems[0]; const startX = firstItem.x; let currentY = firstItem.y;
      return prev.map(item => { if (selectedIds.has(item.id)) { const targetItem = selectedItems.find(si => si.id === item.id); if (targetItem) { const updated = { ...item, x: startX, y: currentY }; currentY += item.height + AUTO_LAYOUT_GAP; return updated; } } return item; });
    });
    showNotification("Vertical alignment applied", "success");
  }, [selectedIds, recordHistory, showNotification]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheelEvent = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('textarea') || target.closest('.picker-grid') || target.closest('.no-scroll-canvas')) return;
      e.preventDefault();
      const scaleAmount = -e.deltaY * 0.0012;
      setView(prev => {
        const newScale = Math.min(Math.max(0.05, prev.scale * (1 + scaleAmount)), 10);
        const rect = container.getBoundingClientRect();
        const mouseX = (e as any).clientX - rect.left;
        const mouseY = (e as any).clientY - rect.top;
        const worldX = (mouseX - prev.x) / prev.scale;
        const worldY = (mouseY - prev.y) / prev.scale;
        return { x: mouseX - worldX * newScale, y: mouseY - worldY * newScale, scale: newScale };
      });
    };
    container.addEventListener('wheel', handleWheelEvent as any, { passive: false });
    return () => container.removeEventListener('wheel', handleWheelEvent as any);
  }, []);

  useEffect(() => {
    const allHistory = items.flatMap(item => item.history.map(h => ({ ...h, timestamp: h.timestamp || Date.now() })));
    setGlobalHistory(prev => {
      const existingUrls = new Set(prev.map(h => h.src));
      const newEntries = allHistory.filter(h => !existingUrls.has(h.src));
      if (newEntries.length === 0) return prev;
      return [...newEntries, ...prev].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 100);
    });
  }, [items]);

  const performUndo = useCallback(() => {
    if (undoStack.length > 0) { const lastState = undoStack[0]; setItems(lastState); setUndoStack(prev => prev.slice(1)); }
  }, [undoStack]);

  const fitAllItems = useCallback(() => {
    if (items.length === 0) { resetView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach(item => { minX = Math.min(minX, item.x); minY = Math.min(minY, item.y); maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height); });
    const rectW = maxX - minX; const rectH = maxY - minY; const viewportW = window.innerWidth; const viewportH = window.innerHeight;
    const scale = Math.min((viewportW * 0.85) / rectW, (viewportH * 0.85) / rectH, 1.5);
    const centerX = minX + rectW / 2; const centerY = minY + rectH / 2;
    setView({ x: viewportW / 2 - (centerX * scale), y: viewportH / 2 - (centerY * scale), scale: scale });
    showNotification("View Fit to Content", "info");
  }, [items, showNotification, resetView]);

  const centerSelection = useCallback(() => {
    if (selectedIds.size === 0) { if (items.length > 0) fitAllItems(); else resetView(); return; }
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedItems.forEach(item => { minX = Math.min(minX, item.x); minY = Math.min(minY, item.y); maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height); });
    const rectW = maxX - minX; const rectH = maxY - minY; const viewportW = window.innerWidth; const viewportH = window.innerHeight;
    const scale = Math.min((viewportW * 0.8) / rectW, (viewportH * 0.8) / rectH, 1.2);
    const centerX = minX + rectW / 2; const centerY = minY + rectH / 2;
    setView({ x: viewportW / 2 - (centerX * scale), y: viewportH / 2 - (centerY * scale), scale: scale });
    showNotification("Selection Focused", "info");
  }, [selectedIds, items, showNotification, fitAllItems, resetView]);

  const getAdaptiveFontSize = (text: string) => {
    const len = text.length;
    if (len < 20) return 'text-[64px]'; 
    if (len < 60) return 'text-[48px]';
    if (len < 120) return 'text-[36px]';
    if (len < 240) return 'text-[28px]';
    return 'text-[22px] leading-relaxed'; 
  };

  // ... (copyPromptToActiveNode, handleImageClickForChat, etc.) ...
  const copyPromptToActiveNode = useCallback((text: string, sourceNodeId: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setItems(prev => {
        const itemsWithEdit = prev.map(item => {
            if (item.id === sourceNodeId) {
                if (item.type === 'image') return { ...item, editPrompt: text };
                if (item.type === 'generator') return { ...item, data: { ...item.data, editPrompt: text } };
                if (item.type === 'video') return { ...item, data: { ...item.data, prompt: text } };
            }
            return item;
        });
        let targetGenId = activeItemId;
        let activeItem = itemsWithEdit.find(i => i.id === targetGenId);
        if (!targetGenId || !activeItem || (activeItem.type !== 'generator' && activeItem.type !== 'video')) {
            const firstGen = itemsWithEdit.find(i => i.type === 'generator' || i.type === 'video');
            if (firstGen) targetGenId = firstGen.id;
        }
        if (targetGenId) {
            return itemsWithEdit.map(item => {
                if (item.id === targetGenId) {
                  if (item.type === 'generator') {
                    return { ...item, data: { ...item.data, prompt: text, mode: 'input' as const } };
                  }
                  if (item.type === 'video') {
                    return { ...item, data: { ...item.data, prompt: text, mode: 'input' as const } };
                  }
                }
                return item;
            });
        }
        return itemsWithEdit;
    });
    setActiveItemId(sourceNodeId); setSelectedIds(new Set([sourceNodeId])); setCopyFeedbackId(sourceNodeId); setTimeout(() => setCopyFeedbackId(null), 2000);
  }, [activeItemId]);

  const handleImageClickForChat = useCallback((src: string, id: string) => {
    showNotification("Added to AI Studio attachments", "info");
    window.dispatchEvent(new CustomEvent('add-image-to-chat', { detail: { src, id } }));
  }, [showNotification]);

  const restoreAssetToCanvas = (entry: HistoryEntry) => {
    const viewportW = window.innerWidth; const viewportH = window.innerHeight;
    const targetW = 512; const targetH = 512;
    const worldX = ((-view.x) + (viewportW / 2) - (targetW / 2)) / view.scale;
    const worldY = ((-view.y) + (window.innerHeight / 2) - (targetH / 2)) / view.scale;
    const id = Math.random().toString(36).substr(2, 9);
    const newZ = topZ + 1;
    const isVideo = isVideoUrl(entry.src);
    if (isVideo) {
        const newItem: VideoGeneratorItem = { id, type: 'video', x: worldX, y: worldY, width: targetW, height: targetH, zIndex: newZ, history: [{ ...entry }], historyIndex: 0, data: { model: 'sora2', prompt: entry.prompt, isGenerating: false, progress: 100, mode: 'result', resultVideo: entry.src, aspectRatio: '16:9', duration: '10s', resolution: '720p' } };
        setItems(prev => [...prev, newItem]);
    } else {
        const newItem: ImageItem = { id, type: 'image', x: worldX, y: worldY, width: targetW, height: targetH, zIndex: newZ, parentIds: [], src: entry.src, history: [{ ...entry }], historyIndex: 0 };
        setItems(prev => [...prev, newItem]);
    }
    setTopZ(newZ); setActiveItemId(id); setSelectedIds(new Set([id])); showNotification("Asset re-deployed to canvas", "success"); setShowHistoryPanel(false);
  };

  const pasteItems = useCallback(() => {
      if (clipboard.length === 0) return;
      recordHistory();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      clipboard.forEach(item => { minX = Math.min(minX, item.x); minY = Math.min(minY, item.y); maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height); });
      const centerX = (minX + maxX) / 2; const centerY = (minY + maxY) / 2;
      let targetX = centerX + 20; let targetY = centerY + 20;
      if (containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); const clientX = mousePosRef.current.x; const clientY = mousePosRef.current.y; if (clientX > 0 && clientY > 0) { const localX = clientX - rect.left; const localY = clientY - rect.top; targetX = (localX - view.x) / view.scale; targetY = (localY - view.y) / view.scale; } }
      const dx = targetX - centerX; const dy = targetY - centerY;
      const newIdsMap = new Map<string, string>();
      const newItems: CanvasItem[] = [];
      let maxZ = topZ;
      clipboard.forEach(item => { const newId = Math.random().toString(36).substr(2, 9); newIdsMap.set(item.id, newId); maxZ++; const clonedItem = JSON.parse(JSON.stringify(item)); clonedItem.id = newId; clonedItem.x = item.x + dx; clonedItem.y = item.y + dy; clonedItem.zIndex = maxZ; clonedItem.parentIds = undefined; newItems.push(clonedItem); });
      newItems.forEach(item => { if (item.type === 'editor') { const oldTargetId = (item as EditorItem).data.targetId; if (oldTargetId && newIdsMap.has(oldTargetId)) { (item as EditorItem).data.targetId = newIdsMap.get(oldTargetId) || null; } else { (item as EditorItem).data.targetId = null; } } });
      setTopZ(maxZ); setItems(prev => [...prev, ...newItems]); const newSelectedIds = new Set(newItems.map(i => i.id)); setSelectedIds(newSelectedIds); if (newItems.length === 1) setActiveItemId(newItems[0].id);
  }, [clipboard, topZ, view, recordHistory]);

  const addNodeFromText = useCallback((text: string) => {
    recordHistory();
    const id = Math.random().toString(36).substr(2, 9);
    let targetX, targetY;
    if (containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); const clientX = mousePosRef.current.x; const clientY = mousePosRef.current.y; if (clientX > 0 && clientY > 0) { const localX = clientX - rect.left; const localY = clientY - rect.top; targetX = (localX - view.x) / view.scale - 220; targetY = (localY - view.y) / view.scale - 220; } else { targetX = ((-view.x) + (window.innerWidth / 2) - 220) / view.scale; targetY = ((-view.y) + (window.innerHeight / 2) - 220) / view.scale; } } else { targetX = 0; targetY = 0; }
    const newItem: GeneratorItem = { id, type: 'generator', x: targetX, y: targetY, width: 540, height: 540, zIndex: topZ + 1, history: [], historyIndex: -1, data: { model: 'flux', prompt: text, negPrompt: '', width: 1024, height: 1024, steps: 9, cfg: 3.5, isGenerating: false, progress: 0, mode: 'input', useLora: true, referenceImages: [] } };
    setTopZ(prev => prev + 1); setItems(prev => [...prev, newItem]); setActiveItemId(id); setSelectedIds(new Set([id])); showNotification("Synthesized node from pasted context", "success");
  }, [view, topZ, recordHistory, showNotification]);

  // ... (handleGroupSelected, toggleGroupCollapse, handlePaste, handleAddImageFromAgent, useEffects for keydown/paste/resize etc)
  const handleGroupSelected = useCallback(() => {
    if (selectedIds.size < 2) { showNotification("Select at least 2 items to group", "info"); return; }
    recordHistory();
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    selectedItems.forEach(item => { minX = Math.min(minX, item.x); minY = Math.min(minY, item.y); maxX = Math.max(maxX, item.x + item.width); maxY = Math.max(maxY, item.y + item.height); });
    const padding = GROUP_PADDING; const groupX = minX - padding; const groupY = minY - padding; const groupW = (maxX - minX) + padding * 2; const groupH = (maxY - minY) + padding * 2;
    const groupId = 'group-' + Math.random().toString(36).substr(2, 9);
    const minZ = Math.min(...selectedItems.map(i => i.zIndex));
    const groupNode: GroupItem = { id: groupId, type: 'group', x: groupX, y: groupY, width: groupW, height: groupH, zIndex: minZ - 0.5, childIds: Array.from(selectedIds), isCollapsed: false, title: "Workspace Group", history: [], historyIndex: -1 };
    setItems(prev => { return [ ...prev.map(item => { if (selectedIds.has(item.id)) return { ...item, groupId }; return item; }), groupNode ]; });
    setSelectedIds(new Set([groupId])); setActiveItemId(groupId); showNotification("Items Grouped", "success");
  }, [selectedIds, items, recordHistory, showNotification]);

  const toggleGroupCollapse = (groupId: string, e?: MouseEvent) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    recordHistory();
    setItems(prev => {
      const group = prev.find(i => i.id === groupId) as GroupItem; if (!group) return prev;
      const isCollapsing = !group.isCollapsed; const collapsedSize = 160; const cx = group.x + group.width / 2; const cy = group.y + group.height / 2;
      return prev.map(item => { if (item.id === groupId) { const g = item as GroupItem; if (isCollapsing) { const newW = collapsedSize; const newH = collapsedSize / 1.6; return { ...g, isCollapsed: true, originalBounds: { w: g.width, h: g.height }, width: newW, height: newH, x: cx - newW / 2, y: cy - newH / 2 }; } else { const newW = g.originalBounds?.w || 500; const newH = g.originalBounds?.h || 300; return { ...g, isCollapsed: false, width: newW, height: newH, x: cx - newW / 2, y: cy - newH / 2 }; } } return item; });
    });
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => { if ((e.target as HTMLElement).matches('input, textarea')) return; const text = e.clipboardData?.getData('text'); if (!text) return; if (text === CLIPBOARD_MARKER) { e.preventDefault(); pasteItems(); } else { e.preventDefault(); addNodeFromText(text); } };
    window.addEventListener('paste', handlePaste); return () => window.removeEventListener('paste', handlePaste);
  }, [pasteItems, addNodeFromText]);

  const handleAddImageFromAgent = useCallback((e: any) => {
    const { src, prompt, parentIds } = e.detail; if (!src) return;
    recordHistory();
    const id = Math.random().toString(36).substr(2, 9);
    const targetW = 512; const targetH = 512;
    let finalX: number = 0; let finalY: number = 0;
    if (parentIds && parentIds.length > 0) { const parent = items.find(i => i.id === parentIds[0]); if (parent) { finalX = parent.x + parent.width + 140; finalY = parent.y; } else { const viewportW = window.innerWidth; const viewportH = window.innerHeight; finalX = ((-view.x) + (viewportW / 2) - (targetW / 2)) / view.scale; finalY = ((-view.y) + (window.innerHeight / 2) - (targetH / 2)) / view.scale; } } else { const viewportW = window.innerWidth; const viewportH = window.innerHeight; finalX = ((-view.x) + (viewportW / 2) - (targetW / 2)) / view.scale; finalY = ((-view.y) + (window.innerHeight / 2) - (targetH / 2)) / view.scale; }
    setTopZ(prevZ => { const newZ = prevZ + 1; setItems(prev => { const newItem: ImageItem = { id, type: 'image', x: finalX, y: finalY, width: targetW, height: targetH, zIndex: newZ, parentIds: parentIds || [], src, history: [{ src, prompt: prompt || "AI Orchestrated Sequence", timestamp: Date.now() }], historyIndex: 0 }; return [...prev, newItem]; }); return newZ; });
    setActiveItemId(id); setSelectedIds(new Set([id])); showNotification("Asset synthesized with multi-point orchestration", "success");
  }, [view, recordHistory, showNotification, items]);

  useEffect(() => { window.addEventListener('add-image-to-canvas', handleAddImageFromAgent); return () => window.removeEventListener('add-image-to-canvas', handleAddImageFromAgent); }, [handleAddImageFromAgent]);

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
        if (e.code === 'Space') setIsSpacePressed(true);
        if (e.key === 'Escape') { if (linkingSourceId) { setLinkingSourceId(null); return; } if (pickingRefForNodeId) { setPickingRefForNodeId(null); setIsCanvasPicking(false); return; } if (showHistoryPanel) { setShowHistoryPanel(false); return; } if (previewImage) setPreviewImage(null); if (editingImage) setEditingImage(null); return; }
        if (e.key.toLowerCase() === 'f' && !(e.target as HTMLElement).matches('input, textarea')) { e.preventDefault(); if (selectedIds.size > 0) centerSelection(); else if (items.length > 0) fitAllItems(); else resetView(); }
        if (e.key.toLowerCase() === 'l' && !(e.target as HTMLElement).matches('input, textarea')) { e.preventDefault(); arrangeSelectedVertically(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); handleGroupSelected(); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { if (!(e.target as HTMLElement).matches('input, textarea')) { e.preventDefault(); performUndo(); } }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') { if (selectedIds.size > 0 && !(e.target as HTMLElement).matches('input, textarea')) { setClipboard(items.filter(i => selectedIds.has(i.id))); navigator.clipboard.writeText(CLIPBOARD_MARKER).catch(() => {}); } }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) { if (!(e.target as HTMLElement).matches('input, textarea')) { recordHistory(); setItems(prev => prev.filter(i => !selectedIds.has(i.id))); setSelectedIds(new Set()); setActiveItemId(null); } }
    };
    const handleKeyUp = (e: globalThis.KeyboardEvent) => { if (e.code === 'Space') setIsSpacePressed(false); };
    window.addEventListener('keydown', handleKeyDown); window.addEventListener('keyup', handleKeyUp);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, [selectedIds, items, clipboard, previewImage, editingImage, showHistoryPanel, pickingRefForNodeId, linkingSourceId, performUndo, recordHistory, resetView, centerSelection, fitAllItems, handleGroupSelected, arrangeSelectedVertically]);

  const handleResizeStart = (e: MouseEvent, id: string) => {
      e.preventDefault(); e.stopPropagation(); recordHistory();
      const item = items.find(i => i.id === id);
      if (item) { setResizeState({ id, startX: e.clientX, startY: e.clientY, startW: item.width, startH: item.height, startSnapshot: JSON.parse(JSON.stringify(items)) }); }
  };

  const addFromCanvas = useCallback((src: string, targetId: string, sourceId: string) => {
    setItems(prev => prev.map(item => {
      if (item.id === targetId) {
        let updatedData = null;
        
        if (item.type === 'generator') {
           const currentRefs = (item as GeneratorItem).data.referenceImages || [];
           if (currentRefs.length < 9 && !currentRefs.includes(src)) {
              updatedData = { ...(item as GeneratorItem).data, referenceImages: [...currentRefs, src] };
           }
        } else if (item.type === 'video') {
           const currentRefs = (item as VideoGeneratorItem).data.referenceImages || [];
           if (!(item as VideoGeneratorItem).data.firstFrameUrl) {
              updatedData = { ...(item as VideoGeneratorItem).data, firstFrameUrl: src };
           } else if (currentRefs.length < 9 && !currentRefs.includes(src)) {
              updatedData = { ...(item as VideoGeneratorItem).data, referenceImages: [...currentRefs, src] };
           }
        }

        if (updatedData) {
           const currentParents = item.parentIds || [];
           const newParents = currentParents.includes(sourceId) ? currentParents : [...currentParents, sourceId];
           
           if (item.type === 'generator') {
                return { ...item, data: updatedData, parentIds: newParents } as GeneratorItem;
           } else if (item.type === 'video') {
                return { ...item, data: updatedData, parentIds: newParents } as VideoGeneratorItem;
           }
        }
      }
      return item;
    }));
    showNotification("Asset linked from workspace", "success"); 
    setPickingRefForNodeId(null); 
    setIsCanvasPicking(false);
  }, [showNotification]);

  const handleMouseDown = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.size-menu-container') && !(e.target as HTMLElement).closest('.picker-container')) { setActiveSizeMenuId(null); if (!isCanvasPicking) setPickingRefForNodeId(null); }
    const isCanvasBg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('canvas-bg');
    if (e.altKey && e.button === 0) { setDragMode('cutting'); if (containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); const worldX = (e.clientX - rect.left - view.x) / view.scale; const worldY = (e.clientY - rect.top - view.y) / view.scale; setCutTrail([{ x: worldX, y: worldY }]); } setIsDragging(true); return; }
    if (isCanvasBg) { if (linkingSourceId) { setLinkingSourceId(null); showNotification("Linking cancelled", "info"); } if (isCanvasPicking) { setIsCanvasPicking(false); setPickingRefForNodeId(null); showNotification("Asset selection cancelled", "info"); return; } }
    if ((e.target as HTMLElement).closest('input, textarea, button, label')) return;
    if (isCanvasBg) { if (isSpacePressed || e.button === 1) { setDragMode('canvas'); setIsDragging(true); setDragStart({ x: e.clientX, y: e.clientY }); } else { setDragMode('selection'); if (!e.shiftKey) { setSelectedIds(new Set()); setActiveItemId(null); } if (containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); const x = e.clientX - rect.left; const y = e.clientY - rect.top; setSelectionBox({ startX: x, startY: y, currentX: x, currentY: y }); } setIsDragging(true); setDragStart({ x: e.clientX, y: e.clientY }); } }
  };

  const getEffectiveNodePos = useCallback((nodeId: string): { x: number; y: number } | null => {
    const item = items.find(i => i.id === nodeId); if (!item) return null;
    if (item.groupId) { const group = items.find(i => i.id === item.groupId) as GroupItem; if (group?.isCollapsed) { return { x: group.x + group.width / 2, y: group.y + group.height / 2 }; } }
    return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
  }, [items]);

  const updateGroupBounds = (groupId: string, currentItems: CanvasItem[]) => {
      const group = currentItems.find(i => i.id === groupId) as GroupItem; if (!group || group.isCollapsed) return currentItems;
      const children = currentItems.filter(i => i.groupId === groupId); if (children.length === 0) return currentItems;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      children.forEach(c => { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x + c.width); maxY = Math.max(maxY, c.y + c.height); });
      const pad = GROUP_PADDING; const targetX = minX - pad; const targetY = minY - pad; const targetW = (maxX - minX) + pad * 2; const targetH = (maxY - minY) + pad * 2;
      return currentItems.map(item => { if (item.id === groupId) { return { ...item, x: Math.min(item.x, targetX), y: Math.min(item.y, targetY), width: Math.max(item.width, (maxX - item.x) + pad), height: Math.max(item.height, (maxY - item.y) + pad) }; } return item; });
  };

  const handleMouseMove = (e: MouseEvent) => {
    mousePosRef.current = { x: e.clientX, y: e.clientY };
    if (resizeState) {
        const scale = view.scale; const dx = (e.clientX - resizeState.startX) / scale; const dy = (e.clientY - resizeState.startY) / scale;
        const targetId = resizeState.id; setItems(prev => prev.map(item => { if (item.id === targetId) { return { ...item, width: Math.max(item.type === 'group' ? 200 : 128, resizeState.startW + dx), height: Math.max(item.type === 'group' ? 120 : 128, resizeState.startH + dy) }; } return item; })); return; 
    }
    if (isDragging) {
      const dx = e.clientX - dragStart.x; const dy = e.clientY - dragStart.y;
      if (dragMode === 'cutting' && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect(); const worldX = (e.clientX - rect.left - view.x) / view.scale; const worldY = (e.clientY - rect.top - view.y) / view.scale;
        const lastPoint = cutTrail[cutTrail.length - 1];
        if (lastPoint) {
          let connectionBroken = false;
          const newItems = items.map(item => { if (item.parentIds && item.parentIds.length > 0) { const newParents = item.parentIds.filter(pId => { const start = getEffectiveNodePos(pId); const end = getEffectiveNodePos(item.id); if (!start || !end) return true; const intersected = checkLineIntersection(lastPoint.x, lastPoint.y, worldX, worldY, start.x, start.y, end.x, end.y); if (intersected) { connectionBroken = true; return false; } return true; }); if (newParents.length !== item.parentIds.length) { return { ...item, parentIds: newParents }; } } return item; });
          if (connectionBroken) { setItems(newItems); showNotification("Neural Connection Severed", "warning"); }
        }
        setCutTrail(prev => [...prev, { x: worldX, y: worldY }].slice(-15));
      } else if (dragMode === 'item' && dragSnapshotRef.current) {
        const scale = view.scale; const totalMoveX = (e.clientX - dragSnapshotRef.current.mouse.x) / scale; const totalMoveY = (e.clientY - dragSnapshotRef.current.mouse.y) / scale;
        const itemsToMoveIds = new Set(selectedIds); items.forEach(item => { if (item.groupId && selectedIds.has(item.groupId)) { itemsToMoveIds.add(item.id); } });
        const initialMap = new Map(dragSnapshotRef.current.items.map(i => [i.id, i]));
        setItems(prev => { const movedItems = prev.map(item => { const snapshot = initialMap.get(item.id); if (itemsToMoveIds.has(item.id) && snapshot) { return { ...item, x: snapshot.x + totalMoveX, y: snapshot.y + totalMoveY }; } return item; }); let finalItems = movedItems; itemsToMoveIds.forEach(id => { const moved = finalItems.find(i => i.id === id); if (moved?.groupId) { finalItems = updateGroupBounds(moved.groupId, finalItems); } }); return finalItems; });
      } else if (dragMode === 'canvas') { setView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy })); setDragStart({ x: e.clientX, y: e.clientY }); } else if (dragMode === 'selection' && selectionBox && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect(); const currentX = e.clientX - rect.left; const currentY = e.clientY - rect.top; setSelectionBox(prev => prev ? ({ ...prev, currentX, currentY }) : null); const boxX = Math.min(selectionBox.startX, currentX); const boxY = Math.min(selectionBox.startY, currentY); const boxW = Math.abs(currentX - selectionBox.startX); const boxH = Math.abs(currentY - selectionBox.startY); const worldX = (boxX - view.x) / view.scale; const worldY = (boxY - view.y) / view.scale; const worldW = boxW / view.scale; const worldH = boxH / view.scale; const newSelectedIds = new Set(e.shiftKey ? selectedIds : []); items.forEach(item => { const isInside = item.x < worldX + worldW && item.x + item.width > worldX && item.y < worldY + worldH && item.y + item.height > worldY; if (isInside) { const parentGroup = items.find(i => i.id === item.groupId) as GroupItem; if (parentGroup?.isCollapsed) return; newSelectedIds.add(item.id); } }); if (newSelectedIds.size !== selectedIds.size || [...newSelectedIds].some(id => !selectedIds.has(id))) { setSelectedIds(newSelectedIds); }
      }
    }
  };

  const handleMouseUp = () => { setIsDragging(false); setResizeState(null); setSelectionBox(null); setDragMode('canvas'); setCutTrail([]); dragSnapshotRef.current = null; };
  const handleTouchStart = (e: TouchEvent) => { if ((e.target as HTMLElement).closest('input, textarea, button, .no-drag')) { if (e.touches.length !== 2) return; } if (e.touches.length === 2) { e.preventDefault(); const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); lastPinchDistRef.current = dist; setDragMode('canvas'); } else if (e.touches.length === 1) { const isCanvasBg = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('canvas-bg'); if (isCanvasBg) { setDragMode('canvas'); setIsDragging(true); setDragStart({ x: e.touches[0].clientX, y: e.touches[0].clientY }); } } };
  const handleTouchMove = (e: TouchEvent) => { if (e.touches.length === 2) { e.preventDefault(); const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (lastPinchDistRef.current) { const scaleChange = dist / lastPinchDistRef.current; const newScale = Math.min(Math.max(0.1, view.scale * scaleChange), 10); const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2; const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2; if (containerRef.current) { const rect = containerRef.current.getBoundingClientRect(); const localX = cx - rect.left; const localY = cy - rect.top; const worldX = (localX - view.x) / view.scale; const worldY = (localY - view.y) / view.scale; setView({ x: localX - worldX * newScale, y: localY - worldY * newScale, scale: newScale }); } } lastPinchDistRef.current = dist; } else if (e.touches.length === 1 && isDragging) { if (!((e.target as HTMLElement).closest('textarea'))) { if (e.cancelable) e.preventDefault(); } const touch = e.touches[0]; const dx = touch.clientX - dragStart.x; const dy = touch.clientY - dragStart.y; if (dragMode === 'item') { setItems(prev => prev.map(item => selectedIds.has(item.id) ? { ...item, x: item.x + dx / view.scale, y: item.y + dy / view.scale } : item)); } else if (dragMode === 'canvas') { setView(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy })); } setDragStart({ x: touch.clientX, y: touch.clientY }); } };
  const handleTouchEnd = () => { setIsDragging(false); lastPinchDistRef.current = null; };
  const handleItemTouchStart = useCallback((e: TouchEvent, id: string) => { e.stopPropagation(); const newZ = topZ + 1; setTopZ(newZ); setItems(prev => prev.map(i => i.id === id ? { ...i, zIndex: newZ } : i)); if (!selectedIds.has(id)) { setSelectedIds(new Set([id])); setActiveItemId(id); } else { setActiveItemId(id); } if (!(e.target as HTMLElement).closest('input, textarea, button')) { recordHistory(); setDragMode('item'); setIsDragging(true); setDragStart({ x: e.touches[0].clientX, y: e.touches[0].clientY }); const targetSelectedIds = new Set(selectedIds); if (!targetSelectedIds.has(id)) targetSelectedIds.add(id); const itemsToSnap = items.filter(i => targetSelectedIds.has(i.id) || (i.groupId && targetSelectedIds.has(i.groupId))); dragSnapshotRef.current = { items: itemsToSnap.map(i => ({ id: i.id, x: i.x, y: i.y })), mouse: { x: e.touches[0].clientX, y: e.touches[0].clientY } }; } }, [topZ, items, selectedIds, recordHistory]);
  
  const handleDragOver = (e: DragEvent) => e.preventDefault();

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault(); 
    const rect = containerRef.current?.getBoundingClientRect(); 
    if (!rect) return;
    
    const clientX = e.clientX; 
    const clientY = e.clientY;
    const worldX = (clientX - view.x) / view.scale; 
    const worldY = (clientY - view.y) / view.scale;
    
    const targetNode = items.find(item => (item.type === 'generator' || item.type === 'video') && worldX >= item.x && worldX <= item.x + item.width && worldY >= item.y && worldY <= item.y + item.height);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      recordHistory();
      const files = Array.from(e.dataTransfer.files);
      
      let offset = 0;
      
      for (const file of files) {
          const isVideo = file.type.startsWith('video/');
          // CRITICAL FIX: Use createObjectURL for video to prevent browser crash due to huge base64 strings
          const persistentUrl = isVideo ? URL.createObjectURL(file) : await fileToDataURL(file);

          if (isVideo) {
              const video = document.createElement('video');
              video.preload = 'metadata';
              video.src = persistentUrl;
              
              await new Promise<void>((resolve) => {
                  video.onloadedmetadata = () => {
                        const maxSide = 540;
                        let finalWidth = video.videoWidth || 540;
                        let finalHeight = video.videoHeight || 540;
                        
                        if (finalWidth > finalHeight) { 
                            finalWidth = maxSide; 
                            finalHeight = (video.videoHeight / video.videoWidth) * maxSide; 
                        } else { 
                            finalHeight = maxSide; 
                            finalWidth = (video.videoWidth / video.videoHeight) * maxSide; 
                        }
                        if (isNaN(finalWidth)) finalWidth = 540;
                        if (isNaN(finalHeight)) finalHeight = 540;

                        const id = Math.random().toString(36).substr(2, 9);
                        const newItem: VideoGeneratorItem = { 
                            id, 
                            type: 'video', 
                            x: (worldX - (finalWidth / 2)) + offset, 
                            y: (worldY - (finalHeight / 2)) + offset, 
                            width: finalWidth, 
                            height: finalHeight, 
                            zIndex: topZ + 1 + offset, 
                            history: [{ src: persistentUrl, prompt: "Uploaded video", timestamp: Date.now() }], 
                            historyIndex: 0, 
                            data: { 
                                model: 'sora2', 
                                prompt: 'Uploaded Video', 
                                isGenerating: false, 
                                progress: 100, 
                                mode: 'result', 
                                resultVideo: persistentUrl,
                                aspectRatio: '16:9',
                                duration: '10s', 
                                resolution: '720p',
                                referenceImages: [] 
                            } 
                        };
                        setItems(prev => [...prev, newItem]); 
                        if (files.length === 1) {
                            setActiveItemId(id); 
                            setSelectedIds(new Set([id]));
                        }
                        resolve();
                  };
                  video.onerror = () => resolve(); // prevent stuck loop
              });
          } else if (file.type.startsWith('image/')) {
              // Handle Images
              if (targetNode && (targetNode.type === 'generator' || targetNode.type === 'video')) {
                if (targetNode.type === 'video' && !targetNode.data.firstFrameUrl) {
                    updateItemData(targetNode.id, { firstFrameUrl: persistentUrl });
                    continue; // Skip creating new node
                }
                const isNanoModel = (targetNode as any).data.model?.startsWith('nano-banana');
                if (isNanoModel || targetNode.type === 'video') {
                  const currentRefs = (targetNode as any).data.referenceImages || [];
                  if (currentRefs.length < 9) { updateItemData(targetNode.id, { referenceImages: [...currentRefs, persistentUrl] }); }
                  continue; // Skip creating new node
                }
              }
              
              await new Promise<void>((resolve) => {
                  const img = new Image(); 
                  img.src = persistentUrl;
                  img.onload = () => {
                      const maxSide = 512; let finalWidth = img.width; let finalHeight = img.height;
                      if (img.width > img.height) { finalWidth = maxSide; finalHeight = (img.height / img.width) * maxSide; } else { finalHeight = maxSide; finalWidth = (img.width / img.height) * maxSide; }
                      const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: (worldX - (finalWidth / 2)) + offset, y: (worldY - (finalHeight / 2)) + offset, width: finalWidth, height: finalHeight, zIndex: topZ + 1 + offset, history: [{ src: persistentUrl, prompt: "Uploaded image", timestamp: Date.now() }], historyIndex: 0, src: persistentUrl };
                      setItems(prev => [...prev, newItem]); 
                      if (files.length === 1) {
                        setActiveItemId(newItem.id); 
                        setSelectedIds(new Set([newItem.id]));
                      }
                      resolve();
                  }
                  img.onerror = () => resolve();
              });
          }
          offset += 40;
      }
      setTopZ(prev => prev + files.length);
    }
  };

  const handleItemMouseDown = useCallback((e: MouseEvent, id: string) => {
      e.stopPropagation(); 
      const targetItem = items.find(i => i.id === id);

      if (e.altKey && e.button === 0) {
        e.preventDefault();
        if (!linkingSourceId) { setLinkingSourceId(id); showNotification("Select target item to link", "info"); } else { if (linkingSourceId !== id) { recordHistory(); setItems(prev => prev.map(item => { if (item.id === id) { const currentParents = item.parentIds || []; if (!currentParents.includes(linkingSourceId!)) { return { ...item, parentIds: [...currentParents, linkingSourceId!] }; } } return item; })); showNotification("Connection established", "success"); } setLinkingSourceId(null); }
        return;
      }

      if (isCanvasPicking && pickingRefForNodeId) { const item = items.find(i => i.id === id); if (item) { const src = item.type === 'image' ? (item as ImageItem).src : (item.type === 'generator' ? (item as GeneratorItem).data.resultImage : (item.type === 'video' ? (item as VideoGeneratorItem).data.resultVideo : undefined)); if (src) { addFromCanvas(src, pickingRefForNodeId, id); return; } } }
      if (e.ctrlKey && e.button === 0) { e.preventDefault(); const item = items.find(i => i.id === id); if (item) { if (item.type === 'image') { handleImageClickForChat(item.src, item.id); return; } else if (item.type === 'generator' && item.data.resultImage) { handleImageClickForChat(item.data.resultImage, item.id); return; } else if (item.type === 'video' && item.data.resultVideo) { handleImageClickForChat(item.data.resultVideo, item.id); return; } } }

      const newZ = topZ + 1; 
      if (targetItem?.type !== 'group') { setTopZ(newZ); setItems(prev => prev.map(i => i.id === id ? { ...i, zIndex: newZ } : i)); }
      const isShift = e.shiftKey; let targetSelectedIds = new Set(selectedIds); if (isShift) { if (targetSelectedIds.has(id)) { targetSelectedIds.delete(id); if (activeItemId === id) setActiveItemId(null); } else { targetSelectedIds.add(id); setActiveItemId(id); } } else { if (!targetSelectedIds.has(id)) { targetSelectedIds = new Set([id]); setActiveItemId(id); } else { setActiveItemId(id); } }
      setSelectedIds(targetSelectedIds);
      if (!(e.target as HTMLElement).closest('input, textarea, button')) { recordHistory(); setDragMode('item'); setIsDragging(true); setDragStart({ x: e.clientX, y: e.clientY }); const itemsToSnap = items.filter(item => targetSelectedIds.has(item.id) || (item.groupId && targetSelectedIds.has(item.groupId))); dragSnapshotRef.current = { items: itemsToSnap.map(i => ({ id: i.id, x: i.x, y: i.y })), mouse: { x: e.clientX, y: e.clientY } }; }
  }, [topZ, items, selectedIds, activeItemId, handleImageClickForChat, recordHistory, isCanvasPicking, pickingRefForNodeId, addFromCanvas, linkingSourceId, showNotification]);

  const addGeneratorNode = () => { recordHistory(); const id = Math.random().toString(36).substr(2, 9); const centerX = ((-view.x) + (window.innerWidth / 2) - 270) / view.scale; const centerY = ((-view.y) + (window.innerHeight / 2) - 270) / view.scale; const newItem: GeneratorItem = { id, type: 'generator', x: centerX, y: centerY, width: 540, height: 540, zIndex: topZ + 1, history: [], historyIndex: -1, data: { model: 'flux', prompt: '', negPrompt: '', width: 1024, height: 1024, steps: 9, cfg: 3.5, isGenerating: false, progress: 0, mode: 'input', useLora: true, referenceImages: [] } }; setTopZ(prev => prev + 1); setItems(prev => [...prev, newItem]); setActiveItemId(id); setSelectedIds(new Set([id])); };
  const addVideoNode = () => { recordHistory(); const id = Math.random().toString(36).substr(2, 9); const centerX = ((-view.x) + (window.innerWidth / 2) - 270) / view.scale; const centerY = ((-view.y) + (window.innerHeight / 2) - 270) / view.scale; const newItem: VideoGeneratorItem = { id, type: 'video', x: centerX, y: centerY, width: 540, height: 540, zIndex: topZ + 1, history: [], historyIndex: -1, data: { model: 'sora2', prompt: '', isGenerating: false, progress: 0, mode: 'input', aspectRatio: '16:9', duration: '10s', resolution: '720p', referenceImages: [] } }; setTopZ(prev => prev + 1); setItems(prev => [...prev, newItem]); setActiveItemId(id); setSelectedIds(new Set([id])); };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      recordHistory(); 
      const files = Array.from(e.target.files);
      let offset = 0;

      for (const file of files) {
          const isVideo = file.type.startsWith('video/');
          // CRITICAL FIX: Use createObjectURL for video to prevent browser crash
          const persistentUrl = isVideo ? URL.createObjectURL(file) : await fileToDataURL(file);
          
          if (isVideo) {
               const video = document.createElement('video');
               video.preload = 'metadata';
               video.src = persistentUrl;
               await new Promise<void>((resolve) => {
                   video.onloadedmetadata = () => {
                        const maxSide = 540;
                        let finalWidth = video.videoWidth || 540;
                        let finalHeight = video.videoHeight || 540;
                        
                        if (finalWidth > finalHeight) { 
                            finalWidth = maxSide; 
                            finalHeight = (video.videoHeight / video.videoWidth) * maxSide; 
                        } else { 
                            finalHeight = maxSide; 
                            finalWidth = (video.videoWidth / video.videoHeight) * maxSide; 
                        }
                        if (isNaN(finalWidth)) finalWidth = 540;
                        if (isNaN(finalHeight)) finalHeight = 540;

                        const centerX = ((-view.x) + (window.innerWidth / 2) - (finalWidth / 2)) / view.scale;
                        const centerY = ((-view.y) + (window.innerHeight / 2) - (finalHeight / 2)) / view.scale;

                        const id = Math.random().toString(36).substr(2, 9);
                        const newItem: VideoGeneratorItem = { 
                            id, 
                            type: 'video', 
                            x: centerX + offset, 
                            y: centerY + offset, 
                            width: finalWidth, 
                            height: finalHeight, 
                            zIndex: topZ + 1 + offset, 
                            history: [{ src: persistentUrl, prompt: "Uploaded video", timestamp: Date.now() }], 
                            historyIndex: 0, 
                            data: { 
                                model: 'sora2', 
                                prompt: 'Uploaded Video', 
                                isGenerating: false, 
                                progress: 100, 
                                mode: 'result', 
                                resultVideo: persistentUrl, 
                                aspectRatio: '16:9', 
                                duration: '10s', 
                                resolution: '720p',
                                referenceImages: [] 
                            } 
                        };
                        setItems(prev => [...prev, newItem]); 
                        if (files.length === 1) {
                            setActiveItemId(id); 
                            setSelectedIds(new Set([id]));
                        }
                        resolve();
                   };
                   video.onerror = () => resolve();
               });
          } else {
               await new Promise<void>((resolve) => {
                   const img = new Image(); img.src = persistentUrl;
                   img.onload = () => {
                       const maxSide = 512; let finalWidth = img.width; let finalHeight = img.height;
                       if (img.width > img.height) { finalWidth = maxSide; finalHeight = (img.height / img.width) * maxSide; } else { finalHeight = maxSide; finalWidth = (img.width / img.height) * maxSide; }
                       const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: ((-view.x) + (window.innerWidth / 2) - (finalWidth / 2)) / view.scale + offset, y: ((-view.y) + (window.innerHeight / 2) - (finalWidth / 2)) / view.scale + offset, width: finalWidth, height: finalHeight, zIndex: topZ + 1 + offset, history: [{ src: persistentUrl, prompt: "Uploaded image", timestamp: Date.now() }], historyIndex: 0, src: persistentUrl };
                       setItems(prev => [...prev, newItem]); 
                       if (files.length === 1) {
                           setActiveItemId(newItem.id); 
                           setSelectedIds(new Set([newItem.id]));
                       }
                       resolve();
                   }
                   img.onerror = () => resolve();
               });
          }
          offset += 40;
      }
      setTopZ(prev => prev + files.length);
      // Reset value to allow re-uploading same files
      e.target.value = '';
    }
  };

  const removeItem = (id: string, e: MouseEvent | TouchEvent) => { e.stopPropagation(); recordHistory(); setItems(prev => prev.filter(i => i.id !== id)); if (activeItemId === id) setActiveItemId(null); setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; }); };
  const updateItemData = (id: string, partialData: any) => { setItems(prev => prev.map(item => { if (item.id === id && (item.type === 'generator' || item.type === 'editor' || item.type === 'video')) { return { ...item, data: { ...item.data, ...partialData } }; } return item; })); };
  
  // ... (translateNodePrompt, updateImageItem, switchImageVersion, removeImageVersion, switchGeneratorVersion, removeGeneratorVersion, convertSrcToFile, stopNodeOperation)
  const translateNodePrompt = async (id: string) => {
    const item = items.find(i => i.id === id) as any;
    if (!item || !item.data.prompt.trim() || item.data.isTranslating) return;
    updateItemData(id, { isTranslating: true });
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: `Translate the following text. If the input is in Chinese, translate it to English. If the input is in English, translate it to Chinese: ${item.data.prompt}. Return ONLY the direct translation string.`, config: { systemInstruction: "Output ONLY the raw translation." } });
      if (response.text) updateItemData(id, { prompt: response.text.trim() });
    } catch (err) { console.error("Node translation failed:", err); } finally { updateItemData(id, { isTranslating: false }); }
  };
  const updateImageItem = (id: string, partialData: Partial<ImageItem>) => { setItems(prev => prev.map(item => (item.id === id && item.type === 'image') ? { ...item, ...partialData } : item)); };
  const switchImageVersion = (itemId: string, index: number) => { recordHistory(); setItems(prev => prev.map(item => (item.id === itemId && item.type === 'image') ? { ...item, src: (item as ImageItem).history[index].src, historyIndex: index } : item)); };
  const removeImageVersion = (itemId: string, index: number, e: MouseEvent) => { e.stopPropagation(); recordHistory(); setItems(prev => prev.map(item => { if (item.id === itemId && item.type === 'image') { const imgItem = item as ImageItem; if (imgItem.history.length <= 1) return imgItem; const newHistory = imgItem.history.filter((_, i) => i !== index); let newIndex = imgItem.historyIndex; if (newIndex >= index) newIndex = Math.max(0, newIndex - 1); return { ...imgItem, history: newHistory, historyIndex: newIndex, src: newHistory[newIndex].src }; } return item; })); };
  const switchGeneratorVersion = (itemId: string, index: number) => { recordHistory(); setItems(prev => prev.map(item => (item.id === itemId && item.type === 'generator') ? { ...item, data: { ...(item as GeneratorItem).data, resultImage: (item as GeneratorItem).history[index].src, mode: 'result' }, historyIndex: index } : item)); };
  const removeGeneratorVersion = (itemId: string, index: number, e: MouseEvent) => { e.stopPropagation(); recordHistory(); setItems(prev => prev.map(item => { if (item.id === itemId && item.type === 'generator') { const genItem = item as GeneratorItem; if (genItem.history.length <= 1) return genItem; const newHistory = genItem.history.filter((_, i) => i !== index); let newIndex = genItem.historyIndex; if (newIndex >= index) newIndex = Math.max(0, newIndex - 1); return { ...genItem, history: newHistory, historyIndex: newIndex, data: { ...genItem.data, resultImage: newHistory[newIndex].src } }; } return item; })); };
  const convertSrcToFile = async (src: string): Promise<File> => { const res = await fetch(src); const blob = await res.blob(); return new File([blob], "source.png", { type: "image/png" }); };
  const stopNodeOperation = async (id: string, e?: MouseEvent) => { if (e) { e.stopPropagation(); e.preventDefault(); } abortedNodeIds.current.add(id); const url = ensureHttps(serverUrl); if (url) { await interruptPrompt(url); } setItems(prev => prev.map(item => { if (item.id === id) { if (item.type === 'image') return { ...item, isRegenerating: false, isEditing: false, isUpscaling: false, isFragmenting: false }; if (item.type === 'generator') return { ...item, data: { ...item.data, isGenerating: false, isEditing: false, isUpscaling: false, isFragmenting: false } }; if (item.type === 'video') return { ...item, data: { ...item.data, isGenerating: false, isEditing: false, isUpscaling: false, isFragmenting: false } }; if (item.type === 'editor') return { ...item, data: { ...item.data, isGenerating: false } }; } return item; })); showNotification("Operation terminated", "info"); };

  // ... (splitImageToGrid, regenerateImage, executeUpscale, executeEdit, executeGeneration, handleEditorSave - all unchanged except minor syntax)
  const splitImageToGrid = async (itemId: string, src: string) => {
    const item = items.find(i => i.id === itemId); if (!item) return;
    if (item.type === 'image') updateImageItem(itemId, { isFragmenting: true }); else if (item.type === 'generator') updateItemData(itemId, { isFragmenting: true });
    showNotification("Fragmenting neural grid...", "info");
    try {
      const img = new Image(); img.crossOrigin = "anonymous"; img.src = src; await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
      const cellW = img.width / 3; const cellH = img.height / 3; const canvas = document.createElement('canvas'); canvas.width = cellW; canvas.height = cellH; const ctx = canvas.getContext('2d');
      const fragments: ImageItem[] = []; const parentPrompt = item.type === 'image' ? (item as ImageItem).history[item.historyIndex]?.prompt : (item as any).data?.prompt;
      let currentZ = topZ + 1; const targetW = 512; const targetH = 512 * (cellH / cellW); const gap = 60; 
      for (let row = 0; row < 3; row++) { for (let col = 0; col < 3; col++) { if (ctx) { ctx.clearRect(0, 0, cellW, cellH); ctx.drawImage(img, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH); const fragmentSrc = canvas.toDataURL('image/png'); const fid = Math.random().toString(36).substr(2, 9); fragments.push({ id: fid, type: 'image', src: fragmentSrc, x: item.x + item.width + 160 + (col * (targetW + gap)), y: item.y + (row * (targetH + gap)), width: targetW, height: targetH, zIndex: currentZ++, parentIds: [itemId], history: [{ src: fragmentSrc, prompt: `Fragment [${row+1},${col+1}] from: ${parentPrompt}`, timestamp: Date.now() }], historyIndex: 0 }); } } }
      setTopZ(currentZ); setItems(prev => { const nextItems = [...prev.map(i => { if (i.id === itemId) { if (i.type === 'image') return { ...i, isFragmenting: false }; if (i.type === 'generator') return { ...i, data: { ...i.data, isFragmenting: false } }; } return i; }), ...fragments]; return nextItems; }); showNotification("Grid fragmented into 9 neural assets", "success");
    } catch (err) { showNotification("Fragmenting failed: Context inaccessible", "error"); if (item.type === 'image') updateImageItem(itemId, { isFragmenting: false }); else if (item.type === 'generator') updateItemData(itemId, { isFragmenting: true }); }
  };
  const regenerateImage = async (itemId: string) => {
      const item = items.find(i => i.id === itemId) as ImageItem; if (!item || item.historyIndex < 0) return; const currentVer = item.history[item.historyIndex]; const url = ensureHttps(serverUrl); if (!url) return; abortedNodeIds.current.delete(itemId); updateImageItem(itemId, { isRegenerating: true }); 
      try { const file = await convertSrcToFile(item.src); const serverFileName = await uploadImage(url, file); const clientId = generateClientId(); const workflow = generateEditWorkflow(currentVer.prompt, serverFileName, currentVer.steps || 20, currentVer.cfg || 2.5); const promptId = await queuePrompt(url, workflow, clientId);
          const checkStatus = async () => { if (abortedNodeIds.current.has(itemId)) return; try { const historyResponse = await getHistory(url, promptId); if (historyResponse[promptId] && historyResponse[promptId].status.status_str === 'success') { const outputs = historyResponse[promptId].outputs; for (const key in outputs) { if (outputs[key].images?.length > 0) { const img = outputs[key].images[0]; const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type); await preloadImage(imgUrl); if (abortedNodeIds.current.has(itemId)) return; const newHistory = [...item.history, { ...currentVer, src: imgUrl, timestamp: Date.now() }]; updateImageItem(itemId, { src: imgUrl, isRegenerating: false, history: newHistory, historyIndex: newHistory.length - 1 }); return; } } } else if (historyResponse[promptId]?.status.status_str === 'error') { showNotification(`生成取消：服务器错误`, 'error'); updateImageItem(itemId, { isRegenerating: false }); return; } setTimeout(checkStatus, 1000); } catch (e) { updateImageItem(itemId, { isRegenerating: false }); } }; checkStatus();
      } catch (e: any) { showNotification(`生成失败：网络连接超时`, 'error'); updateImageItem(itemId, { isRegenerating: false }); }
  };
  const executeUpscale = async (itemId: string) => {
    const item = items.find(i => i.id === itemId); if (!item) return; const url = ensureHttps(serverUrl); if (!url) return; abortedNodeIds.current.delete(itemId); if (item.type === 'image') updateImageItem(itemId, { isUpscaling: true, upscaleProgress: 0 }); else if (item.type === 'generator') updateItemData(itemId, { isUpscaling: true, upscaleProgress: 0 });
    try { let src = item.type === 'image' ? (item as ImageItem).src : ((item as any).data?.resultImage || ''); const file = await convertSrcToFile(src); const serverFileName = await uploadImage(url, file); const clientId = generateClientId(); const workflow = generateUpscaleWorkflow(serverFileName); const promptId = await queuePrompt(url, workflow, clientId);
        const checkStatus = async () => { if (abortedNodeIds.current.has(itemId)) return; try { const history = await getHistory(url, promptId); if (history[promptId] && history[promptId].status.status_str === 'success') { const outputs = history[promptId].outputs; for (const key in outputs) { if (outputs[key].images?.length > 0) { const img = outputs[key].images[0]; const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type); await preloadImage(imgUrl); if (abortedNodeIds.current.has(itemId)) return; const currentPrompt = item.type === 'image' ? (item as ImageItem).history[(item as ImageItem).historyIndex]?.prompt : ((item as any).history?.[(item as any).historyIndex]?.prompt); const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: item.x + item.width + 40, y: item.y, width: 1024, height: 1024, zIndex: topZ + 2, parentIds: [item.id], src: imgUrl, history: [{ src: imgUrl, prompt: `Upscaled: ${currentPrompt || 'Untitled'}`, timestamp: Date.now() }], historyIndex: 0 }; setTopZ(prev => prev + 2); setItems(prev => [...prev, newItem]); setSelectedIds(new Set([newItem.id])); if (item.type === 'image') updateImageItem(itemId, { isUpscaling: false, upscaleProgress: 100 }); else updateItemData(itemId, { isUpscaling: false, upscaleProgress: 100 }); return; } } } else if (history[promptId]?.status.status_str === 'error') { showNotification(`放大取消：资源调度失败`, 'error'); if (item.type === 'image') updateImageItem(itemId, { isUpscaling: false }); else updateItemData(itemId, { isUpscaling: false }); return; } const logs = await getLogs(url); const parsed = parseConsoleProgress(logs); const currentProg = item.type === 'image' ? ((item as ImageItem).upscaleProgress || 0) : ((item as any).data?.upscaleProgress || 0); const newProg = parsed > 0 ? parsed : Math.min(currentProg + 1, 98); if (item.type === 'image') updateImageItem(itemId, { upscaleProgress: newProg }); else updateItemData(itemId, { upscaleProgress: newProg }); setTimeout(checkStatus, 1500); } catch (e) { if (item.type === 'image') updateImageItem(itemId, { isUpscaling: false }); else updateItemData(itemId, { isUpscaling: false }); } }; checkStatus();
    } catch (e) { showNotification(`放大失败：网络连接异常`, 'error'); if (item.type === 'image') updateImageItem(itemId, { isUpscaling: false }); else updateItemData(itemId, { isUpscaling: false }); }
  };
  const executeEdit = async (itemId: string, prompt: string) => {
      const item = items.find(i => i.id === itemId); if (!item) return; abortedNodeIds.current.delete(itemId); const currentMode = item.type === 'image' ? (item.editMode || 'qwen') : (item.type === 'generator' ? (item.data.editMode || 'qwen') : 'qwen'); if (item.type === 'image') updateImageItem(itemId, { isEditing: true, editProgress: 0 }); else if (item.type === 'generator') updateItemData(itemId, { isEditing: true, editProgress: 0 }); const cleanupState = (errorMsg: string) => { if (item.type === 'image') updateImageItem(itemId, { isEditing: false, editProgress: 0 }); else if (item.type === 'generator') updateItemData(itemId, { isEditing: false, editProgress: 0 }); showNotification(`生成取消：${errorMsg}`, 'error'); };
      try { const src = item.type === 'image' ? (item as ImageItem).src : ((item as any).data?.resultImage || '');
          if (currentMode.startsWith('nano-banana')) {
              const apiKey = localStorage.getItem('external_api_key') || ''; const baseUrl = localStorage.getItem('external_base_url') || 'https://api.grsai.com'; const res = await fetch(src); const blob = await res.blob(); const base64 = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onloadend = () => resolve(reader.result as string); reader.readAsDataURL(blob); }); const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/draw/nano-banana`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ model: currentMode, prompt, aspectRatio: "auto", imageSize: "1K", urls: [base64] }) });
              if (!response.ok) { const errorData = await response.json().catch(() => ({})); cleanupState(errorData.message || errorData.msg || `网络错误 (${response.status})`); return; }
              const reader = response.body?.getReader(); const decoder = new TextDecoder(); let finalImageUrl = ""; let buffer = "";
              if (reader) { while (true) { if (abortedNodeIds.current.has(itemId)) { reader.cancel(); break; } const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ""; for (const line of lines) { const cleanLine = line.trim(); if (!cleanLine.startsWith('data:')) continue; const jsonStr = cleanLine.replace('data:', '').trim(); if (jsonStr === '[DONE]') break; try { const data = JSON.parse(jsonStr); if (data.progress !== undefined) { if (item.type === 'image') updateImageItem(itemId, { editProgress: data.progress }); else updateItemData(itemId, { editProgress: data.progress }); } if (data.results?.[0]?.url) finalImageUrl = data.results[0].url; if (data.error || data.status === 'failed') { cleanupState(data.message || "内部错误"); return; } } catch (e) {} } } }
              if (abortedNodeIds.current.has(itemId)) return;
              if (finalImageUrl) { await preloadImage(finalImageUrl); if (abortedNodeIds.current.has(itemId)) return; const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: item.x + item.width + 40, y: item.y, width: item.width, height: item.height, zIndex: topZ + 2, parentIds: [item.id], src: finalImageUrl, history: [{ src: finalImageUrl, prompt, model: currentMode, editMode: currentMode, timestamp: Date.now() }], historyIndex: 0, editMode: currentMode }; setTopZ(prev => prev + 2); setItems(prev => [...prev, newItem]); setSelectedIds(new Set([newItem.id])); if (item.type === 'image') updateImageItem(itemId, { isEditing: false, editProgress: 100, editPrompt: '' }); else updateItemData(itemId, { isEditing: false, editProgress: 100, editPrompt: '' }); } else { cleanupState("未获得生成结果，可能触发了内容过滤"); } return;
          }
          const url = ensureHttps(serverUrl); if (!url) { cleanupState("服务器地址无效"); return; } const file = await convertSrcToFile(src); const serverFileName = await uploadImage(url, file); const clientId = generateClientId(); const workflow = generateEditWorkflow(prompt, serverFileName, 20, 2.5); const promptId = await queuePrompt(url, workflow, clientId);
          const checkStatus = async () => { if (abortedNodeIds.current.has(itemId)) return; try { const historyResponse = await getHistory(url, promptId); if (historyResponse[promptId] && historyResponse[promptId].status.status_str === 'success') { const outputs = historyResponse[promptId].outputs; for (const key in outputs) { if (outputs[key].images?.length > 0) { const img = outputs[key].images[0]; const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type); await preloadImage(imgUrl); if (abortedNodeIds.current.has(itemId)) return; const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: item.x + item.width + 40, y: item.y, width: item.width, height: item.height, zIndex: topZ + 2, parentIds: [item.id], src: imgUrl, history: [{ src: imgUrl, prompt, steps: 20, cfg: 2.5, editMode: 'qwen', timestamp: Date.now() }], historyIndex: 0, editMode: 'qwen' }; setTopZ(prev => prev + 2); setItems(prev => [...prev, newItem]); setSelectedIds(new Set([newItem.id])); if (item.type === 'image') updateImageItem(itemId, { isEditing: false, editProgress: 100, editPrompt: '' }); else updateItemData(itemId, { isEditing: false, editProgress: 100, editPrompt: '' }); return; } } } else if (historyResponse[promptId]?.status.status_str === 'error') { cleanupState("Workflow 运行错误"); return; } const logs = await getLogs(url); const parsed = parseConsoleProgress(logs); const currentProg = item.type === 'image' ? ((item as ImageItem).editProgress || 20) : ((item as any).data?.editProgress || 20); const newProg = parsed > 0 ? parsed : Math.min(currentProg + 2, 95); if (item.type === 'image') updateImageItem(itemId, { editProgress: newProg }); else updateItemData(itemId, { editProgress: newProg }); setTimeout(checkStatus, 1000); } catch (e) { cleanupState("轮询失败"); } }; checkStatus();
      } catch (e: any) { cleanupState(e.message || "网络连接异常"); }
  };
  const executeGeneration = async (itemId: string) => {
      const item = items.find(i => i.id === itemId); if (!item) return; abortedNodeIds.current.delete(itemId); updateItemData(itemId, { isGenerating: true, progress: 0 });
      try {
          if (item.type === 'generator' && (item.data.model === 'nano-banana-pro' || item.data.model === 'nano-banana-fast')) {
              const apiKey = localStorage.getItem('external_api_key') || ''; const baseUrl = localStorage.getItem('external_base_url') || 'https://api.grsai.com'; const payload = { model: item.data.model, prompt: item.data.prompt, aspectRatio: "auto", imageSize: "1K", urls: item.data.referenceImages && item.data.referenceImages.length > 0 ? item.data.referenceImages : undefined }; const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/draw/nano-banana`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
              if (!response.ok) { const errData = await response.json().catch(() => ({})); updateItemData(itemId, { isGenerating: false, progress: 0 }); showNotification(`生成失败：${errData.message || response.statusText}`, 'error'); return; }
              const reader = response.body?.getReader(); const decoder = new TextDecoder(); let finalImageUrl = ""; let buffer = "";
              if (reader) { while (true) { if (abortedNodeIds.current.has(itemId)) { reader.cancel(); break; } const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ""; for (const line of lines) { const cleanLine = line.trim(); if (!cleanLine.startsWith('data:')) continue; const jsonStr = cleanLine.replace('data:', '').trim(); if (jsonStr === '[DONE]') break; try { const data = JSON.parse(jsonStr); if (data.progress !== undefined) updateItemData(itemId, { progress: data.progress }); if (data.results && data.results.length > 0 && data.results[0].url) { finalImageUrl = data.results[0].url; } if (data.error) { updateItemData(itemId, { isGenerating: false, progress: 0 }); showNotification(`生成取消：${data.message}`, 'error'); return; } } catch (e) {} } } }
              if (abortedNodeIds.current.has(itemId)) return;
              if (finalImageUrl) { await preloadImage(finalImageUrl); if (abortedNodeIds.current.has(itemId)) return; const newHistory = [...item.history, { src: finalImageUrl, prompt: item.data.prompt, model: item.data.model, timestamp: Date.now() }]; updateItemData(itemId, { isGenerating: false, progress: 100, resultImage: finalImageUrl, mode: 'result' }); setItems(prev => prev.map(i => i.id === itemId ? { ...i, history: newHistory, historyIndex: newHistory.length - 1 } : i)); } else { updateItemData(itemId, { isGenerating: false, progress: 0 }); showNotification(`生成失败：未获得图片URL`, 'error'); } return;
          }
          if (item.type === 'video') {
              const apiKey = localStorage.getItem('external_api_key') || ''; const baseUrl = localStorage.getItem('external_base_url') || 'https://api.grsai.com'; const isSora = item.data.model === 'sora2'; const endpoint = isSora ? 'v1/video/sora-video' : 'v1/video/veo';
              let payload: any;
              if (isSora) { payload = { model: "sora-2", prompt: item.data.prompt, url: item.data.firstFrameUrl || "", aspectRatio: item.data.aspectRatio, duration: parseInt(item.data.duration), remixTargetId: "", characters: [], size: "small", webHook: "", shutProgress: false }; } else { payload = { model: item.data.model, prompt: item.data.prompt, firstFrameUrl: item.data.firstFrameUrl || "", lastFrameUrl: item.data.lastFrameUrl || "", urls: item.data.referenceImages || [], aspectRatio: item.data.aspectRatio, webHook: "", shutProgress: false }; }
              const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
              if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.message || response.statusText); }
              const reader = response.body?.getReader(); const decoder = new TextDecoder(); let finalVideoUrl = ""; let buffer = "";
              if (reader) { while (true) { if (abortedNodeIds.current.has(itemId)) { reader.cancel(); break; } const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ""; for (const line of lines) { const cleanLine = line.trim(); if (!cleanLine) continue; const jsonStr = cleanLine.startsWith('data:') ? cleanLine.replace('data:', '').trim() : cleanLine; if (jsonStr === '[DONE]') break; try { const data = JSON.parse(jsonStr); if (data.progress !== undefined) updateItemData(itemId, { progress: data.progress }); if (data.url) finalVideoUrl = data.url; if (data.results?.[0]?.url) finalVideoUrl = data.results[0].url; if (data.status === 'succeeded' && data.url) finalVideoUrl = data.url; if (data.status === 'failed') throw new Error(data.failure_reason || data.error || "Synthesis Failed"); } catch (e) {} } } if (buffer.trim() && !abortedNodeIds.current.has(itemId)) { const cleanLine = buffer.trim(); const jsonStr = cleanLine.startsWith('data:') ? cleanLine.replace('data:', '').trim() : cleanLine; try { const data = JSON.parse(jsonStr); if (data.url) finalVideoUrl = data.url; if (data.results?.[0]?.url) finalVideoUrl = data.results[0].url; if (data.status === 'succeeded' && data.url) finalVideoUrl = data.url; } catch(e) {} } }
              if (finalVideoUrl) { const newHistory = [...item.history, { src: finalVideoUrl, prompt: item.data.prompt, model: item.data.model, timestamp: Date.now() }]; updateItemData(item.id, { isGenerating: false, progress: 100, resultVideo: finalVideoUrl, mode: 'result' }); setItems(prev => prev.map(i => i.id === itemId ? { ...i, history: newHistory, historyIndex: newHistory.length - 1 } : i)); } else { throw new Error("Result URL not found in stream data"); } return;
          }
          const url = ensureHttps(serverUrl); if (!url) return;
          let workflow; let promptId; const clientId = generateClientId();
          if (item.type === 'generator') { const data = item.data; if (data.model === 'flux') { workflow = generateFluxWorkflow(data.prompt, data.width, data.height, data.steps, data.useLora ?? true); } else if (data.model === 'sdxl') { workflow = generateSdxlWorkflow(data.prompt, data.negPrompt, data.width, data.height, data.steps, data.cfg); } if (workflow) { promptId = await queuePrompt(url, workflow, clientId); } } else if (item.type === 'editor') { const data = item.data; if (!data.targetId) throw new Error("No target image selected"); const targetImage = items.find(i => i.id === data.targetId) as ImageItem; const file = await convertSrcToFile(targetImage.src); const serverFileName = await uploadImage(url, file); workflow = generateEditWorkflow(data.prompt, serverFileName, data.steps, data.cfg); promptId = await queuePrompt(url, workflow, clientId); }
          if (!promptId) return;
          const checkStatus = async () => { if (abortedNodeIds.current.has(itemId)) return; try { const historyRes = await getHistory(url, promptId); if (historyRes[promptId] && historyRes[promptId].status.status_str === 'success') { const outputs = historyRes[promptId].outputs; for (const key in outputs) { if (outputs[key].images?.length > 0) { const imgUrl = getImageUrl(url, outputs[key].images[0].filename, outputs[key].images[0].subfolder, outputs[key].images[0].type); await preloadImage(imgUrl); if (abortedNodeIds.current.has(itemId)) return; if (item.type === 'generator') { const newHistory = [...item.history, { src: imgUrl, prompt: (item as GeneratorItem).data.prompt, steps: (item as GeneratorItem).data.steps, cfg: (item as GeneratorItem).data.cfg, model: (item as GeneratorItem).data.model, timestamp: Date.now() }]; updateItemData(itemId, { isGenerating: false, progress: 100, resultImage: imgUrl, mode: 'result' }); setItems(prev => prev.map(i => i.id === itemId ? { ...i, history: newHistory, historyIndex: newHistory.length - 1 } : i)); } else { const imgObj = new Image(); imgObj.src = imgUrl; imgObj.onload = () => { const newItem: ImageItem = { id: Math.random().toString(36).substr(2, 9), type: 'image', x: item.x + item.width + 50, y: item.y, width: imgObj.width / 2, height: imgObj.height / 2, zIndex: topZ + 2, parentIds: [item.id], src: imgUrl, history: [{ src: imgUrl, prompt: (item as EditorItem).data.prompt, steps: (item as EditorItem).data.steps, cfg: (item as EditorItem).data.cfg, timestamp: Date.now() }], historyIndex: 0 }; setTopZ(prev => prev + 2); setItems(prev => [...prev, newItem]); setSelectedIds(new Set([newItem.id])); updateItemData(itemId, { isGenerating: false, progress: 100 }); }; } return; } } } else if (historyRes[promptId]?.status.status_str === 'error') { updateItemData(itemId, { isGenerating: false, progress: 0 }); showNotification(`生成取消：服务器运行错误`, 'error'); return; } const logs = await getLogs(url); const parsed = parseConsoleProgress(logs); const currentProg = (item.type === 'generator' || item.type === 'editor') ? item.data.progress : 0; updateItemData(itemId, { progress: parsed > 0 ? parsed : Math.min(currentProg + 2, 95) }); setTimeout(checkStatus, 1000); } catch (e) { updateItemData(itemId, { isGenerating: false, progress: 0 }); } }; checkStatus();
      } catch (e: any) { updateItemData(itemId, { isGenerating: false, progress: 0 }); showNotification(`生成失败：${e.message || '网络连接超时'}`, 'error'); }
  };
  const handleEditorSave = (newSrc: string) => { if (!editingImage) return; recordHistory(); const itemId = editingImage.id; setItems(prev => prev.map(item => { if (item.id === itemId) { const currentPrompt = item.history[item.historyIndex]?.prompt || "Manually Edited"; const newEntry = { src: newSrc, prompt: currentPrompt, timestamp: Date.now() }; if (item.type === 'image') { return { ...item, src: newSrc, history: [...item.history, newEntry], historyIndex: item.history.length }; } if (item.type === 'generator') { return { ...item, data: { ...item.data, resultImage: newSrc }, history: [...item.history, newEntry], historyIndex: item.history.length }; } } return item; })); setEditingImage(null); };

  const renderConnections = () => {
      const connections: React.ReactElement[] = []; 
      const drawnConnections = new Set<string>(); 
      const itemsMap = new Map(items.map(i => [i.id, i]));
      
      items.forEach(item => { 
          if (item.parentIds && item.parentIds.length > 0) { 
              item.parentIds.forEach(pId => { 
                  const parent = itemsMap.get(pId); 
                  if (parent) { 
                      const key = `${parent.id}-${item.id}`; 
                      if (!drawnConnections.has(key)) { 
                          drawnConnections.add(key); 
                          const start = getEffectiveNodePos(pId); 
                          const end = getEffectiveNodePos(item.id); 
                          if (!start || !end) return; 
                          
                          const isActive = selectedIds.has(item.id) || selectedIds.has(parent.id) || (item.groupId && selectedIds.has(item.groupId)) || (parent.groupId && selectedIds.has(parent.groupId)) || linkingSourceId === pId; 
                          
                          connections.push( 
                              <line 
                                  key={key} 
                                  x1={start.x} y1={start.y} x2={end.x} y2={end.y} 
                                  stroke={isActive ? "#3b82f6" : "rgba(100, 116, 139, 0.35)"} // Blue-500 active, Slate-500/35 inactive
                                  strokeWidth={isActive ? "4" : "2.5"} 
                                  strokeDasharray={isActive ? "10 10" : "none"} // Active segments, Inactive solid
                                  strokeLinecap="round" 
                                  className={`transition-all duration-500 connection-line ${isActive ? 'opacity-100 animate-flow drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]' : 'opacity-100'}`} 
                              /> 
                          ); 
                      } 
                  } 
              }); 
          } 
      });
      return connections.length === 0 ? null : ( <svg className="absolute top-0 left-0 pointer-events-none overflow-visible" style={{ width: 1, height: 1, zIndex: 0 }}>{connections}</svg> );
  };

  const renderEditOverlay = ( itemId: string, isEditing: boolean, progress: number, prompt: string | undefined, onPromptChange: (val: string) => void, onExecute: () => void, currentMode: EditMode = 'qwen', onModeChange: (m: EditMode) => void ) => (
      <div className={`absolute bottom-6 left-6 right-20 transition-all duration-700 z-50 pointer-events-auto ${isEditing ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100'}`} onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} >
          <div className="flex flex-col gap-3">
            <div className="flex justify-center gap-1.5 bg-white/90 backdrop-blur-2xl p-1 rounded-full border border-slate-200/50 shadow-premium self-start mb-1">
              {(['qwen', 'nano-banana-pro', 'nano-banana-fast'] as EditMode[]).map(m => ( <button key={m} onClick={() => onModeChange(m)} className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all ${currentMode === m ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-900'}`}> {m === 'qwen' ? 'Qwen' : m.replace('nano-banana-', '').toUpperCase()} </button> ))}
            </div>
            <div className="glass-panel p-2 rounded-2xl flex items-center gap-2 shadow-premium border border-slate-200/60 bg-white/80 backdrop-blur-3xl">
                <input type="text" className="flex-1 bg-transparent border-none text-[13px] font-bold text-slate-900 placeholder:text-slate-400 focus:outline-none px-4 font-sans" placeholder={`Refine with ${currentMode === 'qwen' ? 'Qwen' : 'Nano'}...`} value={prompt || ''} onChange={e => onPromptChange(e.target.value)} onKeyDown={e => e.key === 'Enter' && onExecute()} />
                <button onClick={onExecute} disabled={isEditing || !prompt} className="text-white rounded-xl w-10 h-10 flex items-center justify-center transition-all disabled:opacity-50 shadow-2xl bg-slate-900 hover:scale-105 active:scale-95"> {isEditing ? <div className="w-4 h-4 border-2 border-slate-400 border-t-white rounded-full animate-spin"></div> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12h14M12 5l7 7-7 7"/></svg>} </button>
            </div>
          </div>
          {isEditing && <div className="absolute -top-4 left-0 w-full h-1.5 bg-slate-200 rounded-full overflow-hidden"><div className="h-full transition-all duration-300 bg-blue-500" style={{ width: `${progress}%` }}></div></div>}
      </div>
  );

  const renderResizeHandle = (itemId: string) => ( <div className="absolute bottom-0 right-0 w-10 h-10 z-50 cursor-se-resize flex items-end justify-end p-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-auto" onMouseDown={(e) => handleResizeStart(e, itemId)}> <div className="w-4 h-4 border-b-2 border-r-2 border-slate-400 rounded-br-lg" /> </div> );

  const renderPromptFloat = (prompt: string, steps?: number, cfg?: number, model?: string, nodeId?: string) => (
      <div className="absolute top-0 left-full h-full pl-8 flex flex-col justify-start z-50 opacity-0 group-hover:opacity-100 transition-all duration-700 pointer-events-none group-hover:pointer-events-auto transform translate-x-[-20px] group-hover:translate-x-0" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
          <div className="w-80 max-h-[85%] flex flex-col bg-white/95 backdrop-blur-3xl rounded-[32px] shadow-premium border border-slate-200 origin-left overflow-hidden relative pointer-events-auto">
              {copyFeedbackId === nodeId && <div className="absolute top-4 right-4 bg-emerald-500 text-white text-[10px] font-black px-4 py-2 rounded-full animate-bounce shadow-2xl z-[60] tracking-[0.2em] uppercase">Copied</div>}
              <div className="p-9 overflow-y-auto custom-scrollbar flex-1">
                  <div className="flex items-center justify-between mb-6">
                      <span className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em]">Metadata</span>
                      <button onClick={(e) => { e.stopPropagation(); copyPromptToActiveNode(prompt, nodeId!); }} className="p-3 hover:bg-slate-100 rounded-2xl text-slate-400 hover:text-slate-900 transition-all active:scale-90" title="Copy Prompt"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                  </div>
                  <div className="text-[13px] text-slate-600 font-bold leading-relaxed whitespace-pre-wrap font-sans select-text cursor-pointer hover:text-blue-500 bg-slate-50 p-6 rounded-2xl border border-slate-100 transition-all group/p" onClick={(e) => { e.stopPropagation(); copyPromptToActiveNode(prompt, nodeId!); }}> {prompt} <div className="mt-5 opacity-0 group-hover/p:opacity-100 transition-opacity text-[9px] font-black text-blue-500 uppercase tracking-[0.3em]">Tap to Sync Instruction</div> </div>
              </div>
              <div className="p-8 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
                  <div className="flex gap-6">
                      {steps && <div className="flex flex-col"><span className="text-[9px] text-slate-400 uppercase font-black tracking-widest mb-1">Steps</span><span className="text-sm font-mono font-black text-slate-900">{steps}</span></div>}
                      {cfg && <div className="flex flex-col"><span className="text-[9px] text-slate-400 uppercase font-black tracking-widest mb-1">CFG</span><span className="text-sm font-mono font-black text-slate-900">{cfg}</span></div>}
                  </div>
                  {model && <div className="bg-white text-slate-900 px-4 py-1.5 rounded-xl shadow-lg border border-slate-100"><span className="text-[10px] font-black uppercase tracking-tighter">{model}</span></div>}
              </div>
          </div>
      </div>
  );

  const renderStopButton = (id: string) => ( <button onClick={(e) => stopNodeOperation(id, e)} onMouseDown={(e) => e.stopPropagation()} className="mt-6 w-10 h-10 bg-rose-500 hover:bg-rose-600 text-white rounded-full flex items-center justify-center shadow-lg transition-all transform active:scale-90 animate-pulse pointer-events-auto" title="Stop Process"> <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg> </button> );

  const renderEditNode = (item: EditorItem) => {
      const isActive = activeItemId === item.id || selectedIds.has(item.id);
      return (
        <div className="relative group w-full h-full flex flex-col transition-all duration-300" onMouseDown={e => { if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation(); }}>
            <div className={`w-full h-full glass-panel rounded-[48px] overflow-hidden shadow-glass transition-all duration-700 relative pointer-events-auto border border-slate-200/60 bg-white/60 backdrop-blur-md ${item.data.isGenerating ? 'ring-4 ring-blue-500/30' : ''}`}>
                {item.data.isGenerating && (
                  <div className="absolute inset-0 bg-white/90 backdrop-blur-md z-20 flex flex-col items-center justify-center">
                    <div className="w-12 h-12 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mb-4"></div>
                    <span className="text-[11px] font-black text-slate-500 tracking-[0.4em] uppercase">{item.data.progress}% Refining</span>
                    {renderStopButton(item.id)}
                  </div>
                )}
                <div className="w-full h-full p-10 flex flex-col relative"> <textarea className="w-full flex-1 bg-transparent font-bold text-slate-900 placeholder:text-slate-400 resize-none focus:outline-none text-[15px] leading-relaxed tracking-tight font-sans transition-all duration-300 border-b border-transparent focus:border-slate-300 no-scroll-canvas" placeholder="Instruct refinement..." value={item.data.prompt} onChange={(e) => updateItemData(item.id, { prompt: e.target.value })} /> </div>
            </div>
            <div className={`absolute top-full left-0 w-full flex justify-center pt-8 opacity-0 group-hover:opacity-100 transition-all duration-700 transform -translate-y-4 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50 ${isActive ? 'opacity-100 translate-y-0 pointer-events-auto' : ''}`}><button onClick={() => executeGeneration(item.id)} disabled={!item.data.targetId} className="bg-slate-900 text-white px-10 py-4 rounded-full shadow-premium text-[11px] font-black tracking-widest hover:scale-105 active:scale-95 transition-all flex items-center gap-4 uppercase disabled:opacity-50 pointer-events-auto border border-white/20"><span>Commit Edit</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button></div>
            {renderResizeHandle(item.id)}
        </div>
      );
  };

  const renderImageNode = (item: ImageItem) => {
      const isActive = activeItemId === item.id || selectedIds.has(item.id); const currentEntry = item.history[item.historyIndex];
      return (
      <div className={`relative group w-full h-full select-none pointer-events-none ${isCanvasPicking ? 'cursor-pointer ring-4 ring-blue-500 ring-offset-4' : ''}`} onDoubleClick={(e) => { e.stopPropagation(); setEditingImage({ id: item.id, src: item.src, originalSrc: item.history[0]?.src || item.src }); }}>
          {currentEntry?.prompt && renderPromptFloat(currentEntry.prompt, currentEntry.steps, currentEntry.cfg, undefined, item.id)}
          <div className="w-full h-full rounded-[48px] shadow-glass transition-all duration-1000 bg-white/80 overflow-hidden relative border border-slate-200 pointer-events-auto backdrop-blur-md">
              {(item.isRegenerating || item.isUpscaling || item.isEditing || item.isFragmenting) && (
                <div className="absolute inset-0 bg-white/90 backdrop-blur-xl z-40 flex flex-col items-center justify-center">
                  <div className="w-10 h-10 border-2 border-slate-200 border-t-blue-500 rounded-full animate-spin mb-2"></div>
                  <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.4em]">
                    {item.isRegenerating ? 'Redrawing' : item.isUpscaling ? `Optimizing ${Math.round(item.upscaleProgress || 0)}%` : item.isFragmenting ? 'Fragmenting' : `Modifying ${Math.round(item.editProgress || 0)}%`}
                  </span>
                  {renderStopButton(item.id)}
                </div>
              )}
              {item.history.length > 1 && (
                  <div className="absolute top-6 left-6 flex gap-3 z-40 max-w-[85%] overflow-x-auto no-scrollbar p-1 pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                    {item.history.map((hist, idx) => (
                        <div key={idx} className="relative group/thumb">
                            <button onClick={(e) => { e.stopPropagation(); switchImageVersion(item.id, idx); }} className={`w-10 h-10 rounded-xl overflow-hidden border-2 shadow-soft transition-all duration-500 hover:scale-110 flex-shrink-0 ${item.historyIndex === idx ? 'border-blue-500 ring-4 ring-blue-500/20' : 'border-white/60 opacity-60 hover:opacity-100'}`}>
                                {isVideoUrl(hist.src) ? ( <video src={hist.src} className="w-full h-full object-cover pointer-events-none" muted /> ) : ( <img src={hist.src} className="w-full h-full object-cover pointer-events-none" /> )}
                            </button>
                            <button onClick={(e) => removeImageVersion(item.id, idx, e)} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-rose-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-all shadow-xl hover:bg-rose-600 scale-75 group-hover/thumb:scale-100 border border-white"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                        </div>
                    ))}
                </div>
              )}
              <div className="w-full h-full flex items-center justify-center bg-slate-50/50">
                {item.src ? ( <img src={item.src} alt="artwork" className="max-w-full max-h-full object-contain pointer-events-none select-none transform-gpu" decoding="async" fetchPriority={isActive ? "high" : "auto"} /> ) : ( <div className="flex flex-col items-center gap-2 opacity-20 text-slate-400"> <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> <span className="text-[10px] font-black uppercase tracking-widest">Asset Broken</span> </div> )}
              </div>
              {renderEditOverlay( item.id, !!item.isEditing, item.editProgress || 0, item.editPrompt, (val) => updateImageItem(item.id, { editPrompt: val }), () => executeEdit(item.id, item.editPrompt || ''), item.editMode || 'qwen', (m) => updateImageItem(item.id, { editMode: m }) )}
              <div className={`absolute bottom-6 right-6 z-40 flex flex-col gap-3 items-end transition-opacity duration-500 opacity-0 group-hover:opacity-100 ${isActive ? 'opacity-100' : ''}`}>
                 {!item.isRegenerating && !item.isUpscaling && !item.isFragmenting && (
                    <><button onClick={(e) => { e.stopPropagation(); executeUpscale(item.id); }} className="w-11 h-11 bg-white/90 backdrop-blur-2xl rounded-2xl shadow-premium border border-slate-200 text-emerald-500 flex items-center justify-center hover:scale-115 active:scale-95 transition-all pointer-events-auto" title="4K Upscale"><span className="text-[11px] font-black tracking-tighter">4K</span></button>
                        <button onClick={(e) => { e.stopPropagation(); splitImageToGrid(item.id, item.src); }} className="w-11 h-11 bg-white/90 backdrop-blur-2xl rounded-2xl shadow-premium border border-slate-200 text-slate-600 flex items-center justify-center hover:scale-115 hover:text-indigo-500 active:scale-95 transition-all pointer-events-auto" title="Split 3x3 Grid"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></button>
                        {item.historyIndex >= 0 && item.history[item.historyIndex].prompt !== "Uploaded image" && <button onClick={(e) => { e.stopPropagation(); regenerateImage(item.id); }} className="w-11 h-11 bg-white/90 backdrop-blur-2xl rounded-2xl shadow-premium border border-slate-200 text-slate-600 flex items-center justify-center hover:scale-115 hover:text-blue-500 active:scale-95 transition-all group/refresh pointer-events-auto" title="Regenerate"><svg className="group-hover/refresh:rotate-180 transition-transform duration-1000" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg></button>}
                        <button onClick={(e) => { e.stopPropagation(); setEditingImage({ id: item.id, src: item.src, originalSrc: item.history[0]?.src || item.src }); }} className="w-11 h-11 bg-white/90 backdrop-blur-2xl rounded-2xl shadow-premium border border-slate-200 text-slate-600 flex items-center justify-center hover:scale-115 hover:text-amber-500 active:scale-95 transition-all pointer-events-auto" title="Manual Edit"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button></>
                 )}
                <a href={item.src} download={`studio-export-${item.id}.png`} className="w-11 h-11 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-premium transition-all hover:bg-black hover:scale-115 pointer-events-auto" onClick={e => e.stopPropagation()} title="Export"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>
              </div>
          </div>
          <button className={`absolute -top-2 -right-2 z-50 bg-white text-rose-500 w-8 h-8 flex items-center justify-center rounded-full shadow-premium border border-slate-100 transition-all duration-500 hover:scale-115 hover:bg-rose-50 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 pointer-events-auto ${isActive ? 'opacity-100 scale-100' : ''}`} onClick={(e) => removeItem(item.id, e)} onMouseDown={e => e.stopPropagation()}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
          {renderResizeHandle(item.id)}
      </div>
  );
  };

  const renderVideoNode = (item: VideoGeneratorItem) => {
    const isInput = item.data.mode === 'input';
    const isActive = activeItemId === item.id || selectedIds.has(item.id);
    const displayPrompt = item.data.prompt;

    const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        const files = Array.from(e.target.files) as File[];
        for (const file of files) {
          const persistentUrl = await fileToDataURL(file);
          if (!item.data.firstFrameUrl) { updateItemData(item.id, { firstFrameUrl: persistentUrl }); } else { const currentRefs = item.data.referenceImages || []; if (currentRefs.length < 3) updateItemData(item.id, { referenceImages: [...currentRefs, persistentUrl] }); }
        }
      }
      setPickingRefForNodeId(null);
    };

    const removeRefImage = (idx: number, e: MouseEvent) => { e.stopPropagation(); const currentRefs = item.data.referenceImages || []; updateItemData(item.id, { referenceImages: currentRefs.filter((_, i) => i !== idx) }); };
    const durationOptions: VideoDuration[] = item.data.model === 'sora2' ? ['10s', '15s'] : ['4s', '6s', '8s'];

    return (
      <div className="relative group w-full h-full flex flex-col transition-all duration-300" onMouseDown={e => { if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation(); }}>
          {displayPrompt && renderPromptFloat(displayPrompt, undefined, undefined, item.data.model, item.id)}
          
          {isInput && (
            <div className={`absolute bottom-full left-0 w-full flex flex-col items-center gap-4 pb-10 opacity-0 group-hover:opacity-100 transition-all duration-700 transform translate-y-6 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50 pointer-events-auto ${isActive ? 'opacity-100 translate-y-0 pointer-events-auto' : ''}`}>
                <div className="flex items-center gap-2 p-2 bg-white/90 backdrop-blur-2xl rounded-full shadow-premium border border-slate-200/60 flex-wrap justify-center pointer-events-auto">
                    {(['veo3.1-fast', 'veo3.1-pro', 'sora2'] as VideoModelType[]).map(vm => (
                      <button key={vm} onClick={() => { const newModel = vm; const currentDur = item.data.duration; let nextDur = currentDur; if (newModel === 'sora2' && !['10s', '15s'].includes(currentDur)) { nextDur = '10s'; } else if (newModel !== 'sora2' && ['10s', '15s'].includes(currentDur)) { nextDur = '6s'; } updateItemData(item.id, { model: newModel, duration: nextDur }); }} className={`px-5 py-2.5 text-[9px] tracking-[0.2em] font-black rounded-full transition-all ${ item.data.model === vm ? (vm === 'sora2' ? 'bg-cyan-500 text-white shadow-xl' : 'bg-purple-600 text-white shadow-xl') : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900' }`} > {vm === 'veo3.1-fast' ? 'VEO FAST' : vm === 'veo3.1-pro' ? 'VEO PRO' : 'SORA 2'} </button>
                    ))}
                    <div className="w-[1px] h-5 bg-slate-200 mx-1"></div>
                    <button onClick={() => updateItemData(item.id, { aspectRatio: item.data.aspectRatio === '16:9' ? '9:16' : '16:9' })} className="px-5 py-2.5 text-[9px] font-black text-slate-400 hover:text-slate-900 transition-colors uppercase tracking-[0.2em] flex items-center gap-2"> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 8v8M8 12h8" className={item.data.aspectRatio === '16:9' ? '' : 'rotate-90 origin-center'}/></svg> {item.data.aspectRatio} </button>
                </div>
                
                <div className="flex items-center gap-2 p-1.5 bg-white/90 backdrop-blur-2xl rounded-full shadow-premium border border-slate-200/60 flex-wrap justify-center pointer-events-auto">
                   <div className="flex bg-slate-100 p-1 rounded-full gap-1"> {durationOptions.map(d => ( <button key={d} onClick={() => updateItemData(item.id, { duration: d })} className={`px-4 py-1.5 rounded-full text-[8px] font-black tracking-widest transition-all ${item.data.duration === d ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-900'}`}>{d}</button> ))} </div>
                   <div className="w-[1px] h-5 bg-slate-200 mx-1"></div>
                   <div className="flex bg-slate-100 p-1 rounded-full gap-1"> {(['720p', '1080p'] as VideoResolution[]).map(r => ( <button key={r} onClick={() => updateItemData(item.id, { resolution: r })} className={`px-4 py-1.5 rounded-full text-[8px] font-black tracking-widest transition-all ${item.data.resolution === r ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-900'}`}>{r.toUpperCase()}</button> ))} </div>
                </div>
            </div>
          )}

          <div className={`w-full h-full glass-panel rounded-[48px] overflow-hidden shadow-glass transition-all duration-1000 relative border border-slate-200/60 bg-white/60 backdrop-blur-xl pointer-events-auto ${item.data.isGenerating ? (item.data.model === 'sora2' ? 'ring-8 ring-cyan-500/10' : 'ring-8 ring-purple-500/10') : isActive ? (item.data.model === 'sora2' ? 'ring-2 ring-cyan-500/30' : 'ring-2 ring-purple-500/30') : ''}`}>
              {item.data.isGenerating && (
                <div className="absolute inset-0 bg-white/90 backdrop-blur-2xl z-[55] flex flex-col items-center justify-center">
                  <div className={`w-14 h-14 border-2 border-slate-200 rounded-full animate-spin mb-4 ${item.data.model === 'sora2' ? 'border-t-cyan-500' : 'border-t-purple-500'}`}></div>
                  <span className="text-[12px] font-black text-slate-500 tracking-[0.5em] uppercase">{item.data.progress}% SYNTHESIZING {item.data.model.toUpperCase()}</span>
                  <p className="text-[8px] text-slate-400 font-black uppercase tracking-widest mt-2">Target Duration: {item.data.duration} @ {item.data.resolution}</p>
                  {renderStopButton(item.id)}
                </div>
              )}
              {isInput ? (
                  <div className="w-full h-full p-16 flex flex-col items-center justify-center relative pointer-events-none">
                      <div className="absolute top-8 left-8 flex gap-3 z-40 max-w-[85%] overflow-x-auto no-scrollbar p-1 pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                        {item.history.map((hist, idx) => ( <div key={idx} className="relative group/thumb"> <button onClick={(e) => { e.stopPropagation(); updateItemData(item.id, { mode: 'result', resultVideo: hist.src }); }} className={`w-12 h-12 rounded-2xl overflow-hidden border-2 shadow-soft transition-all duration-500 hover:scale-115 flex-shrink-0 border-white/60 opacity-60 hover:opacity-100`}> <video src={hist.src} className="w-full h-full object-cover pointer-events-none" muted /> </button> </div> ))}
                      </div>

                      <div className="absolute bottom-10 left-10 z-40 flex flex-wrap gap-3.5 max-w-[320px] pointer-events-auto" onMouseDown={e => e.stopPropagation()}>
                           {item.data.firstFrameUrl && (
                              <div className="relative group/ref w-20 h-20 animate-fade-in">
                                 <div className={`w-full h-full rounded-2xl border-2 shadow-premium overflow-hidden hover:scale-115 transition-all duration-300 ${item.data.model === 'sora2' ? 'border-cyan-400' : 'border-purple-400'}`}> <img src={item.data.firstFrameUrl} className="w-full h-full object-cover" /> </div>
                                 <div className={`absolute -top-2 -left-2 text-white px-2 py-0.5 rounded-full text-[7px] font-black uppercase tracking-widest z-50 ${item.data.model === 'sora2' ? 'bg-cyan-600' : 'bg-purple-600'}`}>First</div>
                                 <button onClick={(e) => { e.stopPropagation(); updateItemData(item.id, { firstFrameUrl: undefined }); }} className="absolute -top-2.5 -right-2.5 bg-rose-500 text-white rounded-full w-5.5 h-5.5 flex items-center justify-center shadow-xl opacity-0 group-hover/ref:opacity-100 transition-all border-2 border-white z-50 hover:bg-rose-600 scale-90 hover:scale-100"> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="5"><path d="M18 6L6 18M6 6l12 12"/></svg> </button>
                              </div>
                           )}
                           {(item.data.referenceImages || []).map((ref, idx) => (
                              <div key={idx} className="relative group/ref w-16 h-16 animate-fade-in">
                                 <div className="w-full h-full rounded-2xl border border-white/60 shadow-premium overflow-hidden hover:scale-115 transition-all duration-300"> <img src={ref} className="w-full h-full object-cover" /> </div>
                                 <button onClick={(e) => removeRefImage(idx, e)} className="absolute -top-2.5 -right-2.5 bg-rose-500 text-white rounded-full w-5.5 h-5.5 flex items-center justify-center shadow-xl opacity-0 group-hover/ref:opacity-100 transition-all border-2 border-white z-50 hover:bg-rose-600 scale-90 hover:scale-100"> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="5"><path d="M18 6L6 18M6 6l12 12"/></svg> </button>
                              </div>
                           ))}
                           <div className="relative picker-container pointer-events-auto">
                              <button className={`w-16 h-16 rounded-2xl border-2 border-dashed flex items-center justify-center transition-all hover:scale-115 active:scale-95 ${pickingRefForNodeId === item.id ? (item.data.model === 'sora2' ? 'bg-cyan-500/10 border-cyan-400 text-cyan-500 shadow-inner' : 'bg-purple-500/10 border-purple-400 text-purple-500 shadow-inner') : 'bg-white/40 border-slate-300 text-slate-400 hover:border-slate-400 hover:text-slate-600'}`} onClick={(e) => { e.stopPropagation(); setPickingRefForNodeId(pickingRefForNodeId === item.id ? null : item.id); setIsCanvasPicking(false); }}> <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 5v14M5 12h14"/></svg> </button>
                              {pickingRefForNodeId === item.id && !isCanvasPicking && (
                                <div className="absolute bottom-full left-0 mb-5 bg-white/95 backdrop-blur-3xl rounded-[28px] shadow-2xl border border-slate-200 z-[70] min-w-[240px] animate-slide-up origin-bottom-left overflow-hidden pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                                    <div className="flex flex-col p-1.5">
                                        <button onClick={() => (document.getElementById(`ref-upload-${item.id}`) as HTMLInputElement)?.click()} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 rounded-2xl transition-all group/item text-left"> <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 transition-colors"> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M12 8v4M10 10h4" /></svg> </div> <span className="text-[13px] font-bold text-slate-500 group-hover/item:text-slate-900 tracking-tight">Upload Asset</span> </button>
                                        <div className="h-px bg-slate-100 mx-4" />
                                        <button onClick={() => setIsCanvasPicking(true)} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 rounded-2xl transition-all group/item text-left"> <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 transition-colors"> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m15 15 3 3-3 3" /></svg> </div> <span className="text-[13px] font-bold text-slate-500 group-hover/item:text-slate-900 tracking-tight">From Canvas</span> </button>
                                    </div>
                                    <input type="file" id={`ref-upload-${item.id}`} className="hidden" accept="image/*" multiple onChange={handleRefUpload} />
                                </div>
                              )}
                           </div>
                      </div>
                      <div className="relative w-full flex-1 flex flex-col group/input pointer-events-none">
                        <textarea rows={6} className={`w-full flex-1 bg-transparent font-black text-slate-900 placeholder:text-slate-400 resize-none focus:outline-none text-center leading-[1] tracking-tighter font-sans transition-all duration-500 break-words no-scroll-canvas pointer-events-auto transform-gpu ${getAdaptiveFontSize(item.data.prompt)}`} placeholder="Define Cinematic Vision..." value={item.data.prompt} onChange={(e) => updateItemData(item.id, { prompt: e.target.value })} />
                        <button onClick={() => translateNodePrompt(item.id)} disabled={!item.data.prompt.trim() || item.data.isTranslating} className={`absolute bottom-0 right-0 p-4 transition-all opacity-0 group-hover/input:opacity-100 disabled:opacity-5 active:scale-90 pointer-events-auto ${item.data.model === 'sora2' ? 'text-cyan-500/50 hover:text-cyan-500' : 'text-slate-400 hover:text-purple-500'}`}> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={item.data.isTranslating ? 'animate-spin' : ''}><path d="M5 8l6 6M4 14l10-10M2 5h12M7 2h1M22 22l-5-10-5 10M12.8 18h8.4" /></svg> </button>
                      </div>
                  </div>
              ) : (
                  <div className={`w-full h-full relative group/image bg-black overflow-hidden pointer-events-auto contain-strict`}>
                      <VideoPlayer 
                          src={item.data.resultVideo!} 
                          isActive={isActive} 
                      />
                      <div className={`absolute bottom-14 right-8 z-40 flex flex-col gap-4 items-end transition-opacity duration-500 opacity-0 group-hover:opacity-100 pointer-events-none ${isActive ? 'opacity-100 pointer-events-auto' : ''}`}>
                          <button onClick={(e) => { e.stopPropagation(); updateItemData(item.id, { mode: 'input' }); }} className="w-12 h-12 bg-white/90 backdrop-blur-2xl border border-slate-200 text-slate-600 rounded-[20px] flex items-center justify-center shadow-premium transition-all hover:bg-slate-900 hover:text-white hover:scale-110 pointer-events-auto" title="Modify Prompt"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                          <a href={item.data.resultVideo} download={`studio-video-${item.id}.mp4`} className="w-12 h-12 bg-slate-900 text-white rounded-[20px] flex items-center justify-center shadow-premium transition-all hover:bg-black hover:scale-110 pointer-events-auto" onClick={e => e.stopPropagation()} title="Export"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>
                      </div>
                  </div>
              )}
          </div>
          {isInput && !item.data.isGenerating && (
            <div className={`absolute top-full left-0 w-full flex justify-center pt-10 opacity-0 group-hover:opacity-100 transition-all duration-700 transform -translate-y-6 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50 pointer-events-auto ${isActive ? 'opacity-100 translate-y-0 pointer-events-auto' : ''}`}>
              <button onClick={() => executeGeneration(item.id)} className={`text-white px-12 py-5 rounded-full text-[12px] font-black tracking-[0.2em] hover:scale-105 active:scale-95 transition-all flex items-center gap-5 uppercase pointer-events-auto ${ item.data.model === 'sora2' ? 'bg-cyan-500 shadow-[0_30px_60px_rgba(6,182,212,0.3)] hover:bg-cyan-600' : 'bg-purple-600 shadow-[0_30px_60px_rgba(147,51,234,0.3)] hover:bg-purple-700' }`} > <span>Initiate {item.data.model === 'sora2' ? 'Sora' : 'Veo'} Synthesis</span> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="m15 10 5-5v14l-5-5"/><rect width="15" height="14" x="1" y="5" rx="2" ry="2"/></svg> </button>
            </div>
          )}
          <button className={`absolute -top-2 -right-2 z-50 bg-white text-rose-500 w-10 h-10 flex items-center justify-center rounded-full shadow-premium border border-slate-200 transition-all duration-500 hover:scale-115 hover:bg-rose-50 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 pointer-events-auto ${isActive ? 'opacity-100 scale-100' : ''}`} onClick={(e) => removeItem(item.id, e)} onMouseDown={e => e.stopPropagation()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
          {renderResizeHandle(item.id)}
      </div>
    );
  };

  const renderGeneratorNode = (item: GeneratorItem) => {
      const isInput = item.data.mode === 'input'; const isActive = activeItemId === item.id || selectedIds.has(item.id);
      const currentEntry = !isInput && item.historyIndex >= 0 ? item.history[item.historyIndex] : null;
      const displayPrompt = isInput ? item.data.prompt : (currentEntry?.prompt || item.data.prompt);
      const displaySteps = isInput ? item.data.steps : currentEntry?.steps;
      const displayCfg = isInput ? item.data.cfg : currentEntry?.cfg;
      const displayModel = isInput ? item.data.model : currentEntry?.model;
      const isNanoModel = item.data.model.startsWith('nano-banana');

      const handleRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
          const files = Array.from(e.target.files) as File[];
          for (const file of files) {
             const persistentUrl = await fileToDataURL(file);
             const currentRefs = item.data.referenceImages || [];
             if (currentRefs.length < 9) updateItemData(item.id, { referenceImages: [...currentRefs, persistentUrl] });
          }
        }
        setPickingRefForNodeId(null);
      };

      const removeRefImage = (idx: number, e: MouseEvent) => { e.stopPropagation(); const currentRefs = item.data.referenceImages || []; updateItemData(item.id, { referenceImages: currentRefs.filter((_, i) => i !== idx) }); };

      return (
        <div className="relative group w-full h-full flex flex-col transition-all duration-300" onMouseDown={e => { if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') e.stopPropagation(); }}>
            {displayPrompt && renderPromptFloat(displayPrompt, displaySteps, displayCfg, displayModel, item.id)}
            
            {isInput && (
              <div className={`absolute bottom-full left-0 w-full flex justify-center pb-10 opacity-0 group-hover:opacity-100 transition-all duration-700 transform translate-y-6 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50 pointer-events-auto ${isActive ? 'opacity-100 translate-y-0 pointer-events-auto' : ''}`}>
                  <div className="flex items-center gap-2 p-2 bg-white/90 backdrop-blur-2xl rounded-full shadow-premium border border-slate-200/60 flex-wrap justify-center pointer-events-auto">
                      <button className={`px-5 py-2.5 text-[11px] tracking-[0.2em] font-black rounded-full transition-all ${item.data.model === 'flux' ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900'}`} onClick={() => updateItemData(item.id, { model: 'flux' })}>FLUX</button>
                      <button className={`px-5 py-2.5 text-[11px] tracking-[0.2em] font-black rounded-full transition-all ${item.data.model === 'sdxl' ? 'bg-indigo-600 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900'}`} onClick={() => updateItemData(item.id, { model: 'sdxl' })}>SDXL</button>
                      <button className={`px-5 py-2.5 text-[11px] tracking-[0.2em] font-black rounded-full transition-all ${item.data.model === 'nano-banana-pro' ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900'}`} onClick={() => updateItemData(item.id, { model: 'nano-banana-pro' })}>NANO PRO</button>
                      <button className={`px-5 py-2.5 text-[11px] tracking-[0.2em] font-black rounded-full transition-all ${item.data.model === 'nano-banana-fast' ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-900'}`} onClick={() => updateItemData(item.id, { model: 'nano-banana-fast' })}>NANO FAST</button>
                      {item.data.model === 'flux' && (
                          <>
                              <div className="w-[1px] h-5 bg-slate-200 mx-2"></div>
                              <button onClick={() => updateItemData(item.id, { useLora: !item.data.useLora })} className={`flex items-center gap-2 px-4 py-2.5 rounded-full transition-all ${item.data.useLora ? 'bg-blue-500/20 text-blue-500 border border-blue-500/50' : 'text-slate-400 hover:text-slate-600 border border-transparent'}`}>
                                  <div className={`w-2.5 h-2.5 rounded-full ${item.data.useLora ? 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]' : 'border border-slate-400'}`} />
                                  <span className="text-[11px] font-black tracking-[0.2em] uppercase">LoRA</span>
                              </button>
                          </>
                      )}
                      <div className="w-[1px] h-5 bg-slate-200 mx-3"></div>
                      <div className="relative flex items-center gap-1.5 px-1 size-menu-container">
                          <button className="px-5 py-2.5 text-[11px] font-black text-slate-400 hover:text-slate-900 transition-colors flex items-center gap-2 uppercase tracking-[0.2em]" onClick={(e) => { e.stopPropagation(); setActiveSizeMenuId(activeSizeMenuId === item.id ? null : item.id); }}>{item.data.width} × {item.data.height}</button>
                          {activeSizeMenuId === item.id && (
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 bg-white/95 backdrop-blur-3xl rounded-[32px] shadow-premium border border-slate-200 p-2.5 z-[60] min-w-[220px] animate-fade-in flex flex-col gap-1.5 origin-bottom pointer-events-auto" onWheel={e => e.stopPropagation()}>
                                  <div className="text-[10px] font-black text-slate-400 px-4 py-3 uppercase tracking-[0.3em]">Aspect Presets</div>
                                  {SIZE_PRESETS.map(preset => (
                                      <button key={preset.label} className="text-left px-5 py-3 text-[12px] text-slate-600 hover:bg-slate-50 rounded-2xl hover:text-slate-900 transition-all flex justify-between items-center group/opt" onClick={(e) => { e.stopPropagation(); updateItemData(item.id, { width: preset.w, height: preset.h }); setActiveSizeMenuId(null); }}><span className="font-bold">{preset.label}</span><span className="text-[10px] text-slate-400 font-mono font-bold group-hover/opt:text-slate-600">{preset.w}×{preset.h}</span></button>
                                  ))}
                              </div>
                          )}
                      </div>
                  </div>
              </div>
            )}

            <div className={`w-full h-full glass-panel rounded-[48px] overflow-hidden shadow-glass transition-all duration-1000 relative border border-slate-200/60 bg-white/60 backdrop-blur-xl pointer-events-auto ${item.data.isGenerating ? 'ring-8 ring-blue-500/10' : isActive ? 'ring-2 ring-blue-500/30' : ''}`}>
                {(item.data.isGenerating || item.data.isUpscaling || item.data.isEditing || item.data.isFragmenting) && (
                  <div className="absolute inset-0 bg-white/90 backdrop-blur-2xl z-[55] flex flex-col items-center justify-center">
                    <div className="w-14 h-14 border-2 border-slate-200 border-t-slate-900 rounded-full animate-spin mb-4"></div>
                    <span className="text-[12px] font-black text-slate-500 tracking-[0.5em] uppercase">
                      {item.data.isGenerating ? `${item.data.progress}% SYNTHESIZING` : item.data.isUpscaling ? `OPTIMIZING ${Math.round(item.data.upscaleProgress || 0)}%` : item.data.isFragmenting ? 'FRAGMENTING' : `MODIFYING ${Math.round(item.data.editProgress || 0)}%`}
                    </span>
                    {renderStopButton(item.id)}
                  </div>
                )}
                {isInput ? (
                    <div className="w-full h-full p-16 flex flex-col items-center justify-center relative pointer-events-none">
                        {item.history.length > 0 && (
                            <div className="absolute top-8 left-8 flex gap-3 z-40 max-w-[85%] overflow-x-auto no-scrollbar p-1 pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                                {item.history.map((hist, idx) => (
                                    <div key={idx} className="relative group/thumb"><button onClick={(e) => { e.stopPropagation(); switchGeneratorVersion(item.id, idx); }} className={`w-12 h-12 rounded-2xl overflow-hidden border-2 shadow-soft transition-all duration-500 hover:scale-115 flex-shrink-0 ${item.historyIndex === idx ? 'border-blue-500 ring-4 ring-blue-500/20' : 'border-white/60 opacity-60 hover:opacity-100'}`}><img src={hist.src} className="w-full h-full object-cover pointer-events-none" /></button></div>
                                ))}
                            </div>
                        )}
                        {isNanoModel && (
                        <div className="absolute bottom-10 left-10 z-40 flex flex-wrap gap-3.5 max-w-[220px] pointer-events-auto" onMouseDown={e => e.stopPropagation()}>
                             {(item.data.referenceImages || []).map((ref, idx) => (
                                <div key={idx} className="relative group/ref w-16 h-16 animate-fade-in">
                                   <div className="w-full h-full rounded-2xl border border-white/60 shadow-premium overflow-hidden hover:scale-115 transition-all duration-300"> <img src={ref} className="w-full h-full object-cover" /> </div>
                                   <button onClick={(e) => removeRefImage(idx, e)} className="absolute -top-2.5 -right-2.5 bg-rose-500 text-white rounded-full w-5.5 h-5.5 flex items-center justify-center shadow-xl opacity-0 group-hover/ref:opacity-100 transition-all border-2 border-white z-50 hover:bg-rose-600 scale-90 hover:scale-100"> <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="5"><path d="M18 6L6 18M6 6l12 12"/></svg> </button>
                                </div>
                             ))}
                             {(item.data.referenceImages || []).length < 9 && (
                                <div className="relative picker-container pointer-events-auto">
                                    <button className={`w-16 h-16 rounded-2xl border-2 border-dashed flex items-center justify-center transition-all hover:scale-115 active:scale-95 ${pickingRefForNodeId === item.id ? 'bg-blue-500/10 border-blue-400 text-blue-500 shadow-inner' : 'bg-white/40 border-slate-300 text-slate-400 hover:border-slate-400 hover:text-slate-600'}`} onClick={(e) => { e.stopPropagation(); setPickingRefForNodeId(pickingRefForNodeId === item.id ? null : item.id); setIsCanvasPicking(false); }}> <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 5v14M5 12h14"/></svg> </button>
                                    {pickingRefForNodeId === item.id && !isCanvasPicking && (
                                      <div className="absolute bottom-full left-0 mb-5 bg-white/95 backdrop-blur-3xl rounded-[28px] shadow-2xl border border-slate-200 z-[70] min-w-[240px] animate-slide-up origin-bottom-left overflow-hidden pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                                          <div className="flex flex-col p-1.5">
                                              <button onClick={() => (document.getElementById(`ref-upload-${item.id}`) as HTMLInputElement)?.click()} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 rounded-2xl transition-all group/item text-left"> <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 transition-colors"> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M12 8v4M10 10h4" /></svg> </div> <span className="text-[13px] font-bold text-slate-500 group-hover/item:text-slate-900 tracking-tight">Upload Asset</span> </button>
                                              <div className="h-px bg-slate-100 mx-4" />
                                              <button onClick={() => setIsCanvasPicking(true)} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 rounded-2xl transition-all group/item text-left"> <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 transition-colors"> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m15 15 3 3-3 3" /></svg> </div> <span className="text-[13px] font-bold text-slate-500 group-hover/item:text-slate-900 tracking-tight">From Canvas</span> </button>
                                          </div>
                                          <input type="file" id={`ref-upload-${item.id}`} className="hidden" accept="image/*" multiple onChange={handleRefUpload} />
                                      </div>
                                    )}
                                </div>
                             )}
                        </div>
                        )}
                        <div className="relative w-full flex-1 flex flex-col group/input pointer-events-none">
                          <textarea rows={6} className={`w-full flex-1 bg-transparent font-black text-slate-900 placeholder:text-slate-400 resize-none focus:outline-none text-center leading-[1] tracking-tighter font-sans transition-all duration-500 break-words no-scroll-canvas pointer-events-auto transform-gpu ${getAdaptiveFontSize(item.data.prompt)}`} placeholder="Define Output Concept..." value={item.data.prompt} onChange={(e) => updateItemData(item.id, { prompt: e.target.value })} />
                          <button onClick={() => translateNodePrompt(item.id)} disabled={!item.data.prompt.trim() || item.data.isTranslating} className="absolute bottom-0 right-0 p-4 text-slate-400 hover:text-blue-500 transition-all opacity-0 group-hover/input:opacity-100 disabled:opacity-5 active:scale-90 pointer-events-auto">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={item.data.isTranslating ? 'animate-spin' : ''}> <path d="M5 8l6 6M4 14l10-10M2 5h12M7 2h1M22 22l-5-10-5 10M12.8 18h8.4" /> </svg>
                          </button>
                        </div>
                    </div>
                ) : (
                    <div className={`w-full h-full relative group/image bg-black overflow-hidden pointer-events-auto ${isCanvasPicking ? 'cursor-pointer ring-4 ring-blue-500 ring-offset-4' : ''}`} onDoubleClick={(e) => { e.stopPropagation(); if(item.data.resultImage) setEditingImage({ id: item.id, src: item.data.resultImage, originalSrc: item.history[0]?.src || item.data.resultImage }); }}>
                        {item.history.length > 1 && (
                            <div className="absolute top-8 left-8 flex gap-3 z-40 max-w-[85%] overflow-x-auto no-scrollbar p-1 pointer-events-auto" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
                                {item.history.map((hist, idx) => ( <div key={idx} className="relative group/thumb"><button onClick={(e) => { e.stopPropagation(); switchGeneratorVersion(item.id, idx); }} className={`w-12 h-12 rounded-2xl overflow-hidden border-2 shadow-soft transition-all duration-500 hover:scale-115 flex-shrink-0 ${item.historyIndex === idx ? 'border-blue-500 ring-4 ring-blue-500/20' : 'border-white/60 opacity-60 hover:opacity-100'}`}><img src={hist.src} className="w-full h-full object-cover pointer-events-none" /></button></div> ))}
                            </div>
                        )}
                        <div className="w-full h-full flex items-center justify-center bg-slate-50/50">
                          <img src={item.data.resultImage} className="max-w-full max-h-full object-contain pointer-events-none select-none transform-gpu" alt="result" decoding="async" fetchPriority={isActive ? "high" : "auto"} />
                        </div>
                        {renderEditOverlay( item.id, !!item.data.isEditing, item.data.editProgress || 0, item.data.editPrompt, (val) => updateItemData(item.id, { editPrompt: val }), () => executeEdit(item.id, item.data.editPrompt || ''), item.data.editMode || 'qwen', (m) => updateItemData(item.id, { editMode: m }) )}
                        <div className={`absolute bottom-8 right-8 z-40 flex flex-col gap-4 items-end transition-opacity duration-500 opacity-0 group-hover:opacity-100 pointer-events-none ${isActive ? 'opacity-100 pointer-events-auto' : ''}`}>
                             {!item.data.isGenerating && !item.data.isUpscaling && !item.data.isFragmenting && (
                                <><button onClick={(e) => { e.stopPropagation(); executeUpscale(item.id); }} className="w-12 h-12 bg-white/90 backdrop-blur-2xl rounded-[18px] shadow-premium border border-slate-200 text-emerald-500 flex items-center justify-center hover:scale-115 active:scale-95 transition-all pointer-events-auto" title="4K Upscale"><span className="text-[12px] font-black tracking-tighter">4K</span></button>
                                <button onClick={(e) => { e.stopPropagation(); if(item.data.resultImage) splitImageToGrid(item.id, item.data.resultImage); }} className="w-12 h-12 bg-white/90 backdrop-blur-2xl rounded-[18px] shadow-premium border border-slate-200 text-slate-600 flex items-center justify-center hover:scale-115 hover:text-indigo-500 active:scale-95 transition-all pointer-events-auto" title="Split 3x3 Grid"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></button>
                                <button onClick={(e) => { e.stopPropagation(); executeGeneration(item.id); }} className="w-12 h-12 bg-white/90 backdrop-blur-2xl rounded-[18px] shadow-premium border border-slate-200 text-slate-600 flex items-center justify-center hover:scale-115 hover:text-blue-500 active:scale-95 transition-all group/refresh pointer-events-auto" title="Re-generate"><svg className="group-hover/refresh:rotate-180 transition-transform duration-1000" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg></button></>
                             )}
                             <button onClick={(e) => { e.stopPropagation(); updateItemData(item.id, { mode: 'input' }); }} className="w-12 h-12 bg-white/90 backdrop-blur-2xl border border-slate-200 text-slate-600 rounded-[18px] flex items-center justify-center shadow-premium transition-all hover:bg-slate-900 hover:text-white hover:scale-115 pointer-events-auto" title="Refine Idea"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                            <a href={item.data.resultImage} download={`studio-export-${item.id}.png`} className="w-12 h-12 bg-slate-900 text-white rounded-[18px] flex items-center justify-center shadow-premium transition-all hover:bg-black hover:scale-115 pointer-events-auto" onClick={e => e.stopPropagation()} title="Export"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>
                        </div>
                    </div>
                )}
            </div>
            {isInput && !item.data.isGenerating && <div className={`absolute top-full left-0 w-full flex justify-center pt-10 opacity-0 group-hover:opacity-100 transition-all duration-700 transform -translate-y-6 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto z-50 pointer-events-auto ${isActive ? 'opacity-100 translate-y-0 pointer-events-auto' : ''}`}><button onClick={() => executeGeneration(item.id)} className="bg-slate-900 text-white px-12 py-5 rounded-full shadow-[0_30px_60px_rgba(0,0,0,0.15)] text-[12px] font-black tracking-[0.2em] hover:scale-105 active:scale-95 transition-all flex items-center gap-5 uppercase pointer-events-auto"><span>Initiate Synthesis</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M5 12l7-7 7 7M12 19V5"/></svg></button></div>}
            <button className={`absolute -top-2 -right-2 z-50 bg-white text-rose-500 w-10 h-10 flex items-center justify-center rounded-full shadow-premium border border-slate-200 transition-all duration-500 hover:scale-115 hover:bg-rose-50 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 pointer-events-auto ${isActive ? 'opacity-100 scale-100' : ''}`} onClick={(e) => removeItem(item.id, e)} onMouseDown={e => e.stopPropagation()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
           {renderResizeHandle(item.id)}
        </div>
      );
  };

  const renderGroupNode = (item: GroupItem) => {
    const isActive = activeItemId === item.id || selectedIds.has(item.id);
    return (
      <div className="relative w-full h-full flex flex-col group/container transition-all duration-500">
        <div 
          className={`w-full h-full rounded-[48px] border-2 transition-all duration-500 relative flex flex-col items-center justify-center pointer-events-auto ${isActive ? 'border-blue-500 bg-blue-500/10 shadow-premium' : 'border-slate-300 bg-slate-100/50'} ${item.isCollapsed ? 'bg-white shadow-premium border-solid' : 'border-dashed'}`}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { handleItemMouseDown(e as unknown as MouseEvent, item.id); } }}
        >
          <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-4 px-6 py-2 bg-white/90 rounded-full shadow-premium border border-slate-200 z-50 pointer-events-auto">
             <button onClick={(e) => toggleGroupCollapse(item.id, e)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-900 transition-all">
                {item.isCollapsed ? ( <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg> ) : ( <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg> )}
             </button>
             <span className="text-[10px] font-black text-slate-900 uppercase tracking-[0.2em]">{item.title}</span>
          </div>

          {item.isCollapsed && (
            <div className="flex flex-col items-center gap-2 animate-fade-in pointer-events-none">
              <div className="flex -space-x-4"> {[1, 2, 3].map(i => ( <div key={i} className="w-10 h-10 rounded-xl bg-slate-100 border-2 border-white shadow-soft flex items-center justify-center"> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5"><path d="M12 2L2 7l10 5 10-5-10-5-10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> </div> ))} </div>
              <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest mt-1">{item.childIds.length} Assets Cached</span>
            </div>
          )}
        </div>
        <button className={`absolute -top-4 -right-4 z-50 bg-white text-rose-500 w-9 h-9 flex items-center justify-center rounded-full shadow-premium border border-slate-200 transition-all duration-500 opacity-0 group-hover/container:opacity-100 active:scale-90 pointer-events-auto`} onClick={(e) => removeItem(item.id, e)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        {renderResizeHandle(item.id)}
      </div>
    );
  };

  const renderContent = useCallback((item: CanvasItem) => {
    switch (item.type) { case 'image': return renderImageNode(item as ImageItem); case 'generator': return renderGeneratorNode(item as GeneratorItem); case 'video': return renderVideoNode(item as VideoGeneratorItem); case 'editor': return renderEditNode(item as EditorItem); case 'group': return renderGroupNode(item as GroupItem); default: return null; }
  }, [items, selectedIds, activeItemId, topZ, view, serverUrl, activeSizeMenuId, pickingRefForNodeId, isCanvasPicking, handleItemMouseDown, linkingSourceId]);

  return (
    <div className={`h-full w-full relative overflow-hidden flex font-sans selection:bg-blue-500 selection:text-white ${isDragging && dragMode === 'canvas' ? 'cursor-grabbing' : ''} ${isCanvasPicking ? 'picking-mode' : ''}`}>
      <style>{`
          @keyframes flowAnimation { from { stroke-dashoffset: 40; } to { stroke-dashoffset: 0; } }
          .animate-flow { animation: flowAnimation 1.5s linear infinite; will-change: stroke-dashoffset; }
          .custom-scrollbar::-webkit-scrollbar { width: 4px; }
          .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
          .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }
          @keyframes slideDown { from { transform: translate(-50%, -100%); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
          .animate-slide-down { animation: slideDown 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
          .canvas-bg { background-image: radial-gradient(rgba(15, 23, 42, 0.05) 1.5px, transparent 1.5px); }
          .connection-line { filter: drop-shadow(0 0 2px rgba(59, 130, 246, 0.1)); }
          .selection-active { outline: 2px solid #3b82f6 !important; outline-offset: 4px; box-shadow: 0 0 60px rgba(59, 130, 246, 0.2) !important; }
          .picking-mode div[style*="left"] { cursor: crosshair !important; }
          .picking-mode .selection-active { outline: 3px solid #3b82f6 !important; box-shadow: 0 0 0 20000px rgba(59, 130, 246, 0.08) !important; }
          .picking-mode::after { content: ''; position: fixed; inset: 0; background: radial-gradient(circle at center, transparent 0%, rgba(59, 130, 246, 0.04) 100%); pointer-events: none; z-index: 45; animation: pulse-picking 4s ease-in-out infinite; }
          @keyframes pulse-picking { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.8; } }
          .selection-box { background: rgba(59, 130, 246, 0.05); border: 1px solid rgba(59, 130, 246, 0.5); backdrop-filter: blur(2px); pointer-events: none; z-index: 9999; }
          .no-scrollbar::-webkit-scrollbar { display: none; } .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
          .cutting-trail { fill: none; stroke: #ef4444; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 12px rgba(239, 68, 68, 0.8)); transition: opacity 0.3s ease; stroke-dasharray: 400; stroke-dashoffset: 0; opacity: 0.9; }
          .connection-line, div[style*="transform"] { backface-visibility: hidden; perspective: 1000px; }
      `}</style>

      {notification && (
        <div onClick={() => setNotification(null)} className="fixed top-12 left-1/2 -translate-x-1/2 z-[1000] min-w-[380px] max-w-lg cursor-pointer animate-slide-down">
          <div className={`glass-panel p-5 rounded-[32px] border shadow-premium flex items-center gap-5 backdrop-blur-3xl ${notification.type === 'error' ? 'bg-rose-50/90 border-rose-200' : notification.type === 'warning' ? 'bg-amber-50/90 border-amber-200' : 'bg-white/90 border-slate-200'}`}>
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-premium ${notification.type === 'error' ? 'bg-rose-500 text-white' : notification.type === 'warning' ? 'bg-amber-500 text-white' : 'bg-slate-900 text-white'}`}>
              {notification.type === 'error' ? ( <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ) : notification.type === 'warning' ? ( <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> ) : ( <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg> )}
            </div>
            <div className="flex-1">
              <span className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-1.5">System Protocol</span>
              <p className={`text-[13px] font-bold leading-tight tracking-tight ${notification.type === 'error' ? 'text-rose-600' : notification.type === 'warning' ? 'text-amber-600' : 'text-slate-700'}`}>{notification.message}</p>
            </div>
          </div>
        </div>
      )}

      {isCanvasPicking && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[1000] animate-slide-down pointer-events-none">
          <div className="bg-white/80 backdrop-blur-xl text-slate-900 px-8 py-4 rounded-full shadow-2xl flex items-center gap-5 border border-slate-200">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_#3b82f6]" />
            <span className="text-[11px] font-black uppercase tracking-[0.4em]">Selection Active: Click workspace item</span>
            <button onClick={() => { setIsCanvasPicking(false); setPickingRefForNodeId(null); }} className="pointer-events-auto ml-4 bg-slate-100 hover:bg-slate-200 px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all">Cancel</button>
          </div>
        </div>
      )}

      {linkingSourceId && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[1000] animate-slide-down pointer-events-none">
          <div className="bg-amber-100/90 backdrop-blur-xl text-amber-900 px-8 py-4 rounded-full shadow-2xl flex items-center gap-5 border border-amber-200/50">
            <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse shadow-[0_0_8px_orange]" />
            <span className="text-[11px] font-black uppercase tracking-[0.4em]">Linking Mode: Click target item</span>
            <button onClick={() => setLinkingSourceId(null)} className="pointer-events-auto ml-4 bg-white/50 hover:bg-white/80 px-4 py-1.5 rounded-full text-[9px] font-black uppercase tracking-widest transition-all">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 relative h-full bg-[#f8fafc]">
          <div className="absolute inset-0 pointer-events-none canvas-bg" style={{ backgroundSize: `${32 * view.scale}px ${32 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` }} />
          <div ref={containerRef} className={`absolute inset-0 overflow-hidden ${isSpacePressed ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd} onDragOver={handleDragOver} onDrop={handleDrop}>
              <div className="absolute origin-top-left transform-gpu" style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, willChange: 'transform' }}>
                  {showConnections && renderConnections()}
                  
                  {cutTrail.length > 1 && ( <svg className="absolute top-0 left-0 pointer-events-none overflow-visible" style={{ width: 1, height: 1 }}> <polyline points={cutTrail.map(p => `${p.x},${p.y}`).join(' ')} className="cutting-trail" /> </svg> )}

                  {items.map(item => {
                    let isHidden = false;
                    if (item.groupId) { const parentGroup = items.find(i => i.id === item.groupId) as GroupItem; if (parentGroup?.isCollapsed) isHidden = true; }
                    return ( <MemoNode key={item.id} item={item} isActive={activeItemId === item.id} isSelected={selectedIds.has(item.id)} isLinkingSource={linkingSourceId === item.id} isDragging={isDragging && (selectedIds.has(item.id) || (item.groupId && selectedIds.has(item.groupId)))} onMouseDown={handleItemMouseDown} onTouchStart={handleItemTouchStart} renderContent={renderContent} isHidden={isHidden} /> );
                  })}
              </div>
              {selectionBox && ( <div className="absolute selection-box rounded-[4px]" style={{ left: Math.min(selectionBox.startX, selectionBox.currentX), top: Math.min(selectionBox.startY, selectionBox.currentY), width: Math.abs(selectionBox.currentX - selectionBox.startX), height: Math.abs(selectionBox.currentY - selectionBox.startY) }} /> )}
          </div>

          <div className="absolute top-6 left-6 z-50 group">
              <div className="flex items-center bg-white/60 backdrop-blur-3xl rounded-full border border-slate-200/60 shadow-premium p-1.5 hover:bg-white transition-all">
                  <div className={`w-2.5 h-2.5 rounded-full shadow-inner ${serverUrl ? 'bg-emerald-400' : 'bg-rose-400'} shrink-0`} />
                  <div className="w-0 overflow-hidden group-hover:w-48 focus-within:w-48 transition-all duration-700 ease-out opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} className="bg-transparent border-none text-[10px] font-mono font-bold text-slate-600 w-full pl-3 pr-2 focus:outline-none placeholder:text-slate-400" placeholder="Workspace Server" />
                  </div>
              </div>
          </div>
          
          <div className="absolute bottom-6 left-6 flex gap-3 z-50">
              <div className="glass-panel p-1 rounded-full flex gap-1 shadow-premium bg-white/80 border-slate-200 backdrop-blur-md">
                  <button className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-900 transition-all active:scale-90" onClick={() => setView(prev => ({ ...prev, scale: Math.max(prev.scale / 1.25, 0.05) }))}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                  <span className="flex items-center justify-center w-10 text-[9px] font-black text-slate-500 uppercase tracking-widest">{Math.round(view.scale * 100)}%</span>
                  <button className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-900 transition-all active:scale-90" onClick={() => setView(prev => ({ ...prev, scale: Math.min(prev.scale * 1.25, 10) }))}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
              </div>
              <button className="w-10 h-10 bg-white rounded-full text-slate-400 hover:text-slate-900 hover:shadow-premium transition-all shadow-premium flex items-center justify-center border border-slate-200 active:scale-90" onClick={selectedIds.size > 0 ? centerSelection : (items.length > 0 ? fitAllItems : resetView)} title="Viewport Control (F)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg></button>
          </div>

          <div className="absolute bottom-10 right-10 z-50 flex flex-col gap-4">
            <button className={`w-14 h-14 bg-white/80 backdrop-blur-md rounded-2xl shadow-premium flex items-center justify-center transition-all hover:scale-110 active:scale-95 border border-slate-200 ${showConnections ? 'text-blue-500' : 'text-slate-400'}`} onClick={() => setShowConnections(!showConnections)} title="Topology Visibility">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" className={showConnections ? 'opacity-100' : 'opacity-20'}></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" className={showConnections ? 'opacity-100' : 'opacity-20'}></line></svg>
            </button>
            <button onClick={clearWorkspace} className="w-14 h-14 bg-rose-50 text-rose-500 hover:bg-rose-500 hover:text-white rounded-2xl shadow-premium flex items-center justify-center border border-rose-100 transition-all hover:scale-110 active:scale-95 group/purge" title="Wipe Workspace">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
            </button>
          </div>

          <div className="absolute left-10 top-1/2 -translate-y-1/2 flex flex-row items-center gap-8 group py-12 pr-16 z-50">
            <button className={`w-14 h-14 bg-slate-900 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] flex items-center justify-center text-white transition-all duration-500 group-hover:rotate-90 group-hover:scale-110 active:scale-90 shrink-0 z-[60] border border-slate-800 group-hover:bg-black group-hover:shadow-[0_30px_60px_rgba(0,0,0,0.5)] ${showHistoryPanel ? 'rotate-90 scale-90 bg-black' : ''}`}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            
            <div className="flex flex-col gap-5 items-start opacity-0 group-hover:opacity-100 transition-all duration-600 transform -translate-x-6 group-hover:translate-x-0 pointer-events-none group-hover:pointer-events-auto">
              <button onClick={addGeneratorNode} className="flex items-center gap-5 group/item transition-all duration-300" style={{ transitionDelay: '0ms' }}>
                <div className="w-12 h-12 bg-white rounded-[18px] shadow-premium flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 group-hover/item:scale-115 group-hover/item:shadow-premium-hover transition-all duration-300 border border-slate-100"> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4"></path><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"></polygon></svg> </div>
                <div className="flex flex-col bg-white/90 backdrop-blur-3xl px-6 py-3 rounded-[20px] shadow-premium border border-slate-100 opacity-0 group-hover/item:opacity-100 transition-all duration-500 translate-x-[-12px] group-hover/item:translate-x-0 scale-95 group-hover/item:scale-100 origin-left"> <span className="text-[10px] font-black text-slate-900 uppercase tracking-[0.2em] leading-none mb-1">Synthesis Core</span> <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.3em] leading-none">New Node</span> </div>
              </button>

              <button onClick={addVideoNode} className="flex items-center gap-5 group/item transition-all duration-300" style={{ transitionDelay: '40ms' }}>
                <div className="w-12 h-12 bg-white rounded-[18px] shadow-premium flex items-center justify-center text-slate-400 group-hover/item:text-purple-500 group-hover/item:scale-115 group-hover/item:shadow-premium-hover transition-all duration-300 border border-slate-100"> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m15 10 5-5v14l-5-5"/><rect width="15" height="14" x="1" y="5" rx="2" ry="2"/></svg> </div>
                <div className="flex flex-col bg-white/90 backdrop-blur-3xl px-6 py-3 rounded-[20px] shadow-premium border border-slate-100 opacity-0 group-hover/item:opacity-100 transition-all duration-500 translate-x-[-12px] group-hover/item:translate-x-0 scale-95 group-hover/item:scale-100 origin-left"> <span className="text-[10px] font-black text-slate-900 uppercase tracking-[0.2em] leading-none mb-1">Cinematic Suite</span> <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.3em] leading-none">New Video</span> </div>
              </button>

              <button onClick={() => setShowHistoryPanel(true)} className="flex items-center gap-5 group/item transition-all duration-300" style={{ transitionDelay: '80ms' }}>
                <div className="w-12 h-12 bg-white rounded-[18px] shadow-premium flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 group-hover/item:scale-115 group-hover/item:shadow-premium-hover transition-all duration-300 border border-slate-100"> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> </div>
                <div className="flex flex-col bg-white/90 backdrop-blur-3xl px-6 py-3 rounded-[20px] shadow-premium border border-slate-100 opacity-0 group-hover/item:opacity-100 transition-all duration-500 translate-x-[-12px] group-hover/item:translate-x-0 scale-95 group-hover/item:scale-100 origin-left"> <span className="text-[10px] font-black text-slate-900 uppercase tracking-[0.2em] leading-none mb-1">Asset Index</span> <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.3em] leading-none">History</span> </div>
              </button>

              <input type="file" id="fab-upload" className="hidden" accept="image/*,video/*" multiple onChange={handleUpload} />
              <label htmlFor="fab-upload" className="flex items-center gap-5 cursor-pointer group/item transition-all duration-300" style={{ transitionDelay: '120ms' }}>
                <div className="w-12 h-12 bg-white rounded-[18px] shadow-premium flex items-center justify-center text-slate-400 group-hover/item:text-slate-900 group-hover/item:scale-115 group-hover/item:shadow-premium-hover transition-all duration-300 border border-slate-100"> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg> </div>
                <div className="flex flex-col bg-white/90 backdrop-blur-3xl px-6 py-3 rounded-[20px] shadow-premium border border-slate-100 opacity-0 group-hover/item:opacity-100 transition-all duration-500 translate-x-[-12px] group-hover/item:translate-x-0 scale-95 group-hover/item:scale-100 origin-left"> <span className="text-[10px] font-black text-slate-900 uppercase tracking-[0.2em] mb-1">Import External</span> <span className="text-[8px] font-bold text-slate-400 uppercase tracking-[0.3em]">Raw Asset</span> </div>
              </label>
            </div>
          </div>

          {showHistoryPanel && ( <div className="fixed inset-0 z-50 bg-white/40 backdrop-blur-md" onClick={() => setShowHistoryPanel(false)} /> )}

          <div className={`fixed left-0 top-0 bottom-0 w-96 z-[60] transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] transform ${showHistoryPanel ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'}`}>
             <div className="w-full h-full glass-panel border-r border-slate-200 bg-white/95 backdrop-blur-[60px] shadow-2xl flex flex-col">
                <div className="p-10 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                   <div className="flex flex-col"> <h2 className="text-[16px] font-black text-slate-900 uppercase tracking-[0.2em] leading-none">Repository</h2> <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.3em] mt-3 block">Neural Session Cache</span> </div>
                   <button onClick={() => setShowHistoryPanel(false)} className="w-12 h-12 flex items-center justify-center rounded-2xl text-slate-400 hover:bg-slate-100 hover:text-slate-900 transition-all active:scale-90"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
                
                <div className="flex-1 overflow-y-auto custom-scrollbar p-8 space-y-8">
                   <div className="mb-8 p-6 bg-slate-50/80 rounded-3xl border border-slate-100">
                      <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mb-4">Workspace Archive</h3>
                      <div className="grid grid-cols-2 gap-3">
                         <button onClick={exportProjectFile} className="flex flex-col items-center gap-3 p-4 bg-white rounded-2xl border border-slate-200 hover:bg-slate-900 hover:text-white transition-all group/arch text-slate-600 shadow-sm"> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="group-hover/arch:scale-110 transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> <span className="text-[8px] font-black uppercase tracking-widest">Backup</span> </button>
                         <label className="flex flex-col items-center gap-3 p-4 bg-white rounded-2xl border border-slate-200 hover:bg-slate-900 hover:text-white transition-all group/arch cursor-pointer text-slate-600 shadow-sm"> <input type="file" className="hidden" accept=".json" onChange={importProjectFile} /> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="group-hover/arch:scale-110 transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> <span className="text-[8px] font-black uppercase tracking-widest">Restore</span> </label>
                      </div>
                   </div>

                   {globalHistory.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center px-6"> <div className="w-20 h-20 rounded-[32px] bg-slate-50 flex items-center justify-center text-slate-300 mb-8"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div> <p className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.2em] leading-relaxed">No data footprints in workspace</p> </div>
                   ) : (
                      <div className="grid grid-cols-2 gap-5">
                         {globalHistory.map((entry, idx) => {
                            const isVideo = isVideoUrl(entry.src);
                            return ( <div key={idx} className="group/asset relative aspect-square rounded-3xl overflow-hidden bg-white border border-slate-200 cursor-pointer shadow-sm hover:shadow-lg transition-all duration-700 hover:scale-[1.03]" onClick={() => restoreAssetToCanvas(entry)}> {isVideo ? ( <video src={entry.src} className="w-full h-full object-cover transition-transform duration-1000 group-hover/asset:scale-125" muted playsInline /> ) : ( <img src={entry.src} className="w-full h-full object-cover transition-transform duration-1000 group-hover/asset:scale-125" alt="cached" decoding="async" loading="lazy" /> )} <div className="absolute inset-0 bg-white/80 backdrop-blur-[4px] opacity-0 group-hover/asset:opacity-100 transition-opacity flex items-center justify-center p-6"> <span className="text-slate-900 text-[9px] font-black uppercase tracking-widest text-center line-clamp-4 leading-relaxed">{entry.prompt}</span> </div> </div> );
                         })}
                      </div>
                   )}
                </div>
                <div className="p-10 bg-slate-50/50 border-t border-slate-100 text-center"> <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em]">Capacity: {globalHistory.length} / 100</p> </div>
             </div>
          </div>

          {editingImage && <ImageEditor src={editingImage.src} originalSrc={editingImage.originalSrc} onSave={handleEditorSave} onCancel={() => setEditingImage(null)} />}
          {previewImage && <div className="fixed inset-0 z-[100] bg-white/80 backdrop-blur-[80px] flex items-center justify-center p-16 animate-fade-in" onClick={() => setPreviewImage(null)}><button className="absolute top-12 right-12 text-slate-400 hover:text-slate-900 transition-all bg-white rounded-full p-4 shadow-premium active:scale-90 border border-slate-200" onClick={() => setPreviewImage(null)}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button><div className="relative max-w-[95vw] max-h-[95vh] flex gap-12 shadow-[0_100px_200px_rgba(0,0,0,0.1)] rounded-[48px] bg-white p-4 border border-slate-100" onClick={e => e.stopPropagation()}><img src={previewImage.src} className="max-w-[85vw] max-h-[90vh] object-contain rounded-[32px] bg-slate-50 transform-gpu" onLoad={(e) => { const img = e.target as HTMLImageElement; setPreviewImage(prev => prev ? { ...prev, dims: { w: img.naturalWidth, h: img.naturalHeight } } : null); }} />{previewImage.dims && <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-5 px-8 py-4 bg-white/95 backdrop-blur-2xl rounded-full shadow-premium text-slate-900 z-50 animate-fade-in pointer-events-none select-none"><span className="text-[11px] font-black text-slate-400 uppercase tracking-[0.4em]">Master Native Res</span><div className="w-px h-5 bg-slate-200"></div><span className="text-sm font-mono font-black tracking-[0.1em]">{previewImage.dims.w} <span className="text-slate-300">×</span> {previewImage.dims.h}</span></div>}</div></div>}
      </div>
    </div>
  );
};

export default InfiniteCanvasTab;
