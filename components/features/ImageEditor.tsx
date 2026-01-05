
import React, { useState, useRef, useEffect, useCallback } from 'react';
import Button from '../ui/Button';

interface ImageEditorProps {
  src: string;
  originalSrc?: string; 
  onSave: (newSrc: string) => void;
  onCancel: () => void;
}

type Tool = 'brush' | 'crop';

const ImageEditor: React.FC<ImageEditorProps> = ({ src, originalSrc, onSave, onCancel }) => {
  const [tool, setTool] = useState<Tool>('brush');
  const [brushColor, setBrushColor] = useState('#0f172a');
  const [brushSize, setBrushSize] = useState(12);
  const [isDrawing, setIsDrawing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  const isPanningRef = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  const cropStartPos = useRef<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingLayerRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const pushToHistory = useCallback(() => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png', 0.9);
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(dataUrl);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [history, historyIndex]);

  const loadInitialImage = useCallback(async (customSrc?: string) => {
    setIsLoading(true);
    const targetSrc = customSrc || src;
    
    // Use an Image object for pre-loading to ensure canvas doesn't lag
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = targetSrc;
    
    img.onload = () => {
      requestAnimationFrame(() => {
        if (canvasRef.current && drawingLayerRef.current && viewportRef.current) {
          const canvas = canvasRef.current;
          const drawLayer = drawingLayerRef.current;
          const viewport = viewportRef.current;

          canvas.width = img.width;
          canvas.height = img.height;
          drawLayer.width = img.width;
          drawLayer.height = img.height;

          const ctx = canvas.getContext('2d', { alpha: false });
          if (ctx) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
          }
          
          const dataUrl = canvas.toDataURL('image/png', 0.8);
          setHistory([dataUrl]);
          setHistoryIndex(0);

          const viewRect = viewport.getBoundingClientRect();
          const padding = 160;
          const availableW = viewRect.width - padding;
          const availableH = viewRect.height - padding;

          const scaleX = availableW / img.width;
          const scaleY = availableH / img.height;
          const fitScale = Math.min(scaleX, scaleY, 0.95);
          
          setZoom(fitScale);
          setOffset({ x: 0, y: 0 });
          setCropRect(null);
          setIsLoading(false);
        }
      });
    };
    
    img.onerror = () => {
      console.error("Failed to load image in editor");
      setIsLoading(false);
    };
  }, [src]);

  useEffect(() => {
    loadInitialImage();
  }, [loadInitialImage]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        setIsPanning(false);
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove, { passive: true });
    window.addEventListener('mouseup', handleGlobalMouseUp, { capture: true });

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp, { capture: true });
    };
  }, []);

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      const img = new Image();
      img.src = history[prevIndex];
      img.onload = () => {
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx && canvasRef.current) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.drawImage(img, 0, 0);
          setHistoryIndex(prevIndex);
        }
      };
    }
  }, [history, historyIndex]);

  const handleWheel = (e: React.WheelEvent) => {
    if (isPanningRef.current) return;
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.08 : 0.92;
    setZoom(prev => Math.min(Math.max(0.02, prev * factor), 20));
  };

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingLayerRef.current) return { x: 0, y: 0 };
    const canvas = drawingLayerRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const startAction = (e: React.MouseEvent | React.TouchEvent) => {
    if (isLoading) return;
    const isTouchEvent = 'touches' in e;
    const clientX = isTouchEvent ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = isTouchEvent ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY;
    const button = 'button' in e ? (e as React.MouseEvent).button : 0;

    if (button === 1) {
      e.preventDefault();
      isPanningRef.current = true;
      setIsPanning(true);
      lastMousePos.current = { x: clientX, y: clientY };
      return;
    }

    if (e.currentTarget === viewportRef.current) return;
    if (isPanningRef.current) return;

    const { x, y } = getCoordinates(e);
    if (tool === 'brush') {
      setIsDrawing(true);
      const ctx = drawingLayerRef.current?.getContext('2d');
      if (ctx) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineWidth = brushSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = brushColor;
      }
    } else if (tool === 'crop') {
      setIsCropping(true);
      cropStartPos.current = { x, y };
      setCropRect({ x, y, w: 0, h: 0 });
    }
  };

  const moveAction = (e: React.MouseEvent | React.TouchEvent) => {
    if (isPanningRef.current || isLoading) return;
    const { x, y } = getCoordinates(e);
    if (isDrawing && tool === 'brush') {
      const ctx = drawingLayerRef.current?.getContext('2d');
      if (ctx) {
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    } else if (isCropping && tool === 'crop' && cropStartPos.current) {
      setCropRect({
        x: Math.min(x, cropStartPos.current.x),
        y: Math.min(y, cropStartPos.current.y),
        w: Math.abs(x - cropStartPos.current.x),
        h: Math.abs(y - cropStartPos.current.y)
      });
    }
  };

  const endAction = () => {
    if (isLoading) return;
    if (isDrawing && tool === 'brush') {
      setIsDrawing(false);
      if (canvasRef.current && drawingLayerRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        ctx?.drawImage(drawingLayerRef.current, 0, 0);
        const dCtx = drawingLayerRef.current.getContext('2d');
        dCtx?.clearRect(0, 0, drawingLayerRef.current.width, drawingLayerRef.current.height);
        pushToHistory();
      }
    } else if (isCropping && tool === 'crop') {
      setIsCropping(false);
    }
  };

  const handleSave = () => {
    if (!canvasRef.current || isLoading) return;
    if (tool === 'crop' && cropRect && cropRect.w > 5 && cropRect.h > 5) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = cropRect.w;
      tempCanvas.height = cropRect.h;
      const tCtx = tempCanvas.getContext('2d');
      tCtx?.drawImage(canvasRef.current, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
      onSave(tempCanvas.toDataURL('image/png'));
    } else {
      onSave(canvasRef.current.toDataURL('image/png'));
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-white/60 backdrop-blur-[120px] flex flex-col font-sans animate-editor-in select-none overflow-hidden text-slate-900">
      {/* Top Navigation Capsule */}
      <div className="absolute top-12 left-1/2 -translate-x-1/2 w-[90%] max-w-5xl h-16 flex items-center justify-between z-[220] px-8 rounded-full bg-white/90 border border-white shadow-premium">
        <div className="flex items-center gap-8">
          <button onClick={onCancel} className="text-slate-300 hover:text-slate-950 transition-all p-2.5 hover:bg-slate-50 rounded-2xl active:scale-90" title="Dismiss">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <div className="h-6 w-[1px] bg-slate-100" />
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-[0.4em] leading-none mb-2">Edit Phase</span>
            <span className="text-[14px] font-black text-slate-950 uppercase tracking-[0.1em] leading-none">{tool === 'brush' ? 'Visual Overlay' : 'Area Definition'}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button onClick={handleUndo} disabled={historyIndex <= 0 || isLoading} className="w-11 h-11 flex items-center justify-center rounded-2xl text-slate-300 hover:bg-slate-50 hover:text-slate-950 disabled:opacity-5 transition-all active:scale-90" title="History Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-15 9 9 0 0 0-6 2.3L3 7"></path></svg>
          </button>
          <div className="w-[1px] h-6 bg-slate-100" />
          <button onClick={() => loadInitialImage()} disabled={isLoading} className="px-6 py-2.5 text-[10px] font-black text-rose-500 hover:bg-rose-50 rounded-2xl transition-all flex items-center gap-3 border border-transparent hover:border-rose-100 uppercase tracking-widest" title="Purge modifications">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            Restore Raw
          </button>
          <div className="w-[1px] h-6 bg-slate-100" />
          <button 
            className="bg-slate-950 text-white px-8 py-3 rounded-2xl text-[11px] font-black tracking-[0.2em] uppercase hover:bg-black transition-all shadow-premium active:scale-95 disabled:opacity-50" 
            onClick={handleSave}
            disabled={isLoading}
          >
            Commit Changes
          </button>
        </div>
      </div>

      {/* Vertical Tool Dock */}
      <div className="absolute left-12 top-1/2 -translate-y-1/2 flex flex-col gap-4 p-2.5 rounded-[32px] bg-white/90 border border-white shadow-premium z-[220]">
        <button 
          onClick={() => { setTool('brush'); setCropRect(null); }}
          className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${tool === 'brush' ? 'bg-slate-950 text-white shadow-premium scale-110' : 'text-slate-300 hover:text-slate-950 hover:bg-slate-50'}`}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path></svg>
        </button>
        <button 
          onClick={() => setTool('crop')}
          className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${tool === 'crop' ? 'bg-slate-950 text-white shadow-premium scale-110' : 'text-slate-300 hover:text-slate-950 hover:bg-slate-50'}`}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>
        </button>
        <div className="h-[1px] w-10 bg-slate-50 mx-auto my-2" />
        <button onClick={() => setZoom(z => z * 1.3)} className="w-14 h-14 rounded-2xl text-slate-300 hover:text-slate-950 flex items-center justify-center transition-all hover:bg-slate-50 active:scale-90 font-black text-xl">+</button>
        <button onClick={() => setZoom(z => z / 1.3)} className="w-14 h-14 rounded-2xl text-slate-300 hover:text-slate-950 flex items-center justify-center transition-all hover:bg-slate-50 active:scale-90 font-black text-xl">-</button>
      </div>

      {/* Parameter Control Panel */}
      <div className="absolute right-12 top-1/2 -translate-y-1/2 w-72 flex flex-col gap-8 p-8 rounded-[40px] bg-white/90 border border-white shadow-premium text-slate-950 z-[220]">
        <div>
          <h3 className="text-[10px] font-black text-slate-300 uppercase tracking-[0.4em] mb-6">Parameters</h3>
          
          {tool === 'brush' ? (
            <div className="space-y-8">
              <div>
                <div className="flex justify-between items-center mb-4">
                  <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Weight</span>
                  <span className="text-xs font-mono font-black">{brushSize}px</span>
                </div>
                <input 
                  type="range" min="1" max="150" 
                  className="w-full h-1 bg-slate-100 rounded-full appearance-none accent-slate-950 cursor-pointer"
                  value={brushSize}
                  onChange={(e) => setBrushSize(parseInt(e.target.value))}
                />
              </div>
              <div>
                <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-4">Spectrum</span>
                <div className="grid grid-cols-4 gap-3">
                  {['#0f172a', '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ffffff', '#ec4899'].map(c => (
                    <button 
                      key={c}
                      className={`w-9 h-9 rounded-2xl border border-slate-100 shadow-soft transition-all ${brushColor === c ? 'ring-2 ring-slate-950 scale-115 shadow-premium' : 'opacity-40 hover:opacity-100'}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setBrushColor(c)}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="p-6 bg-slate-50/40 rounded-3xl border border-slate-100 shadow-inner-premium">
                <span className="text-[10px] font-black text-slate-400 uppercase block mb-4 tracking-[0.2em]">Selection Info</span>
                {cropRect ? (
                  <div className="space-y-3">
                    <div className="flex justify-between text-[12px] font-mono"><span className="text-slate-400 uppercase font-black text-[9px] tracking-widest">Width</span><span className="font-black">{Math.round(cropRect.w)}px</span></div>
                    <div className="flex justify-between text-[12px] font-mono"><span className="text-slate-400 uppercase font-black text-[9px] tracking-widest">Height</span><span className="font-black">{Math.round(cropRect.h)}px</span></div>
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-300 leading-relaxed font-bold uppercase tracking-tight italic">Drag on canvas to define synthesis area...</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="pt-6 border-t border-slate-100 flex justify-between items-center">
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Neural Scale</span>
            <span className="text-[12px] font-mono font-black text-slate-950">{(zoom * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* Editor Viewport */}
      <div 
        ref={viewportRef}
        className={`flex-1 relative flex items-center justify-center p-40 overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-default'} will-change-transform`}
        onWheel={handleWheel}
        onMouseDown={startAction}
      >
        {isLoading && (
          <div className="absolute inset-0 z-[230] bg-white/40 flex flex-col items-center justify-center animate-fade-in">
             <div className="w-16 h-16 border-2 border-slate-100 border-t-slate-950 rounded-full animate-spin mb-8 shadow-premium"></div>
             <span className="text-[12px] font-black text-slate-400 tracking-[0.8em] uppercase">Initializing Canvas</span>
          </div>
        )}
        <div 
          className="relative shadow-[0_120px_240px_rgba(0,0,0,0.2)] bg-white origin-center will-change-transform transition-transform duration-75"
          style={{ 
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            minWidth: canvasRef.current?.width ? `${canvasRef.current.width}px` : 'auto',
            minHeight: canvasRef.current?.height ? `${canvasRef.current.height}px` : 'auto'
          }}
        >
          <canvas ref={canvasRef} className="block pointer-events-none" />
          <canvas 
            ref={drawingLayerRef} 
            className={`absolute inset-0 w-full h-full block z-10 ${isPanning ? 'pointer-events-none' : (tool === 'brush' ? 'cursor-crosshair' : 'cursor-cell')}`}
            onMouseDown={startAction}
            onMouseMove={moveAction}
            onMouseUp={endAction}
            onMouseLeave={endAction}
          />
          
          {tool === 'crop' && cropRect && (
            <div className="absolute inset-0 pointer-events-none z-20">
              <div 
                className="absolute inset-0 bg-slate-950/30 backdrop-blur-[4px]" 
                style={{
                  clipPath: `polygon(
                    0% 0%, 0% 100%, 
                    ${(cropRect.x / (drawingLayerRef.current?.width || 1)) * 100}% 100%, 
                    ${(cropRect.x / (drawingLayerRef.current?.width || 1)) * 100}% ${(cropRect.y / (drawingLayerRef.current?.height || 1)) * 100}%, 
                    ${((cropRect.x + cropRect.w) / (drawingLayerRef.current?.width || 1)) * 100}% ${(cropRect.y / (drawingLayerRef.current?.height || 1)) * 100}%, 
                    ${((cropRect.x + cropRect.w) / (drawingLayerRef.current?.width || 1)) * 100}% ${((cropRect.y + cropRect.h) / (drawingLayerRef.current?.height || 1)) * 100}%, 
                    ${(cropRect.x / (drawingLayerRef.current?.width || 1)) * 100}% ${((cropRect.y + cropRect.h) / (drawingLayerRef.current?.height || 1)) * 100}%, 
                    ${(cropRect.x / (drawingLayerRef.current?.width || 1)) * 100}% 100%, 
                    100% 100%, 100% 0%
                  )`
                }} 
              />
              <div 
                className="absolute border-[3px] border-slate-950 shadow-premium"
                style={{ 
                  left: `${(cropRect.x / (drawingLayerRef.current?.width || 1)) * 100}%`, 
                  top: `${(cropRect.y / (drawingLayerRef.current?.height || 1)) * 100}%`, 
                  width: `${(cropRect.w / (drawingLayerRef.current?.width || 1)) * 100}%`, 
                  height: `${(cropRect.h / (drawingLayerRef.current?.height || 1)) * 100}%` 
                }}
              >
                <div className="absolute -top-2 -left-2 w-4 h-4 bg-white rounded-full border-2 border-slate-950 shadow-premium" />
                <div className="absolute -top-2 -right-2 w-4 h-4 bg-white rounded-full border-2 border-slate-950 shadow-premium" />
                <div className="absolute -bottom-2 -left-2 w-4 h-4 bg-white rounded-full border-2 border-slate-950 shadow-premium" />
                <div className="absolute -bottom-2 -right-2 w-4 h-4 bg-white rounded-full border-2 border-slate-950 shadow-premium" />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[10px] font-black text-slate-300 tracking-[1em] uppercase">
        Studio Core Architectural Module
      </div>
    </div>
  );
};

export default ImageEditor;
