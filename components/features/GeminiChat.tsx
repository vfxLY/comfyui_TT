
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import { ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId, preloadImage } from '../../services/api';
import { generateFluxWorkflow, generateSdxlWorkflow } from '../../services/workflows';

interface PendingImage {
  url: string;
  base64: string;
  type: string;
  canvasItemId?: string;
  isLoading?: boolean;
}

interface ChatImage {
  url: string;
  canvasItemId?: string;
}

interface Message {
  role: 'user' | 'model';
  text: string;
  images?: ChatImage[];
  isError?: boolean;
  modelUsed?: string;
}

type ModelMode = 'auto' | 'pro' | 'vision';
type DrawModel = 'nano-banana-pro' | 'nano-banana-fast' | 'flux' | 'sdxl' | 'veo3.1-fast' | 'veo3.1-pro' | 'sora2';
type Resolution = '1K' | '2K' | '4K';
type VideoDuration = '4s' | '6s' | '8s' | '10s' | '15s';
type VideoResolution = '720p' | '1080p';

const isVideoUrl = (url: string) => url.toLowerCase().match(/\.(mp4|webm|mov|ogg)$/) || url.includes('/video/');

const GeminiChat: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedModelMode, setSelectedModelMode] = useState<ModelMode>('auto');
  const [selectedDrawModel, setSelectedDrawModel] = useState<DrawModel>('flux');
  const [selectedResolution, setSelectedResolution] = useState<Resolution>('1K');
  const [selectedVideoDuration, setSelectedVideoDuration] = useState<VideoDuration>('6s');
  const [selectedVideoResolution, setSelectedVideoResolution] = useState<VideoResolution>('720p');
  const [useLora, setUseLora] = useState(true);
  
  const [externalKey, setExternalKey] = useState<string>(localStorage.getItem('external_api_key') || '');
  const [externalBaseUrl, setExternalBaseUrl] = useState<string>(localStorage.getItem('external_base_url') || 'https://api.grsai.com');

  const [input, setInput] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: 'Hello. I am your Studio Agent. I can assist with conceptual orchestration and visual synthesis.' }
  ]);
  const [isTyping, setIsTyping] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [hasAistudio, setHasAistudio] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isAbortedRef = useRef(false);

  const COMFY_SERVER_URL = "https://17610400098.top";

  useEffect(() => {
    if (window.aistudio) {
      setHasAistudio(true);
    }
  }, []);

  useEffect(() => {
    if (selectedDrawModel === 'sora2') {
      if (selectedVideoDuration !== '10s' && selectedVideoDuration !== '15s') {
        setSelectedVideoDuration('10s');
      }
    } else if (selectedDrawModel.startsWith('veo')) {
      if (['10s', '15s'].includes(selectedVideoDuration)) {
        setSelectedVideoDuration('6s');
      }
    }
  }, [selectedDrawModel]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const targetHeight = Math.min(Math.max(scrollHeight, 60), 140);
      textareaRef.current.style.height = `${targetHeight}px`;
    }
  }, [input]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  useEffect(() => {
    const handleAddImage = async (e: any) => {
      const { src, id } = e.detail;
      if (!src) return;
      
      setIsOpen(true);

      setPendingImages(prev => {
        if (prev.some(p => p.canvasItemId === id)) return prev;
        return [...prev, { url: src, base64: '', type: 'image/png', canvasItemId: id, isLoading: true }];
      });

      try {
        let base64Data = '';
        let mimeType = 'image/png';

        if (src.startsWith('data:')) {
          const parts = src.split(',');
          base64Data = parts[1];
          mimeType = parts[0].split(':')[1].split(';')[0];
        } else {
          const res = await fetch(src);
          const blob = await res.blob();
          mimeType = blob.type;
          base64Data = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.readAsDataURL(blob);
          });
        }

        setPendingImages(prev => prev.map(img => 
          img.canvasItemId === id ? { ...img, base64: base64Data, type: mimeType, isLoading: false } : img
        ));
      } catch (err) {
        console.error("Failed to process canvas image for chat", err);
        setPendingImages(prev => prev.filter(img => img.canvasItemId !== id));
      }
    };
    window.addEventListener('add-image-to-chat', handleAddImage);
    return () => window.removeEventListener('add-image-to-chat', handleAddImage);
  }, []);

  const saveSettings = () => {
    localStorage.setItem('external_api_key', externalKey);
    localStorage.setItem('external_base_url', externalBaseUrl);
    setIsSettingsOpen(false);
  };

  const handleSelectApiKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
    }
  };

  const ensureApiKey = async () => {
    const key = process.env.API_KEY;
    if (key && key.trim() !== '') return true;
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        return true;
      }
      return true;
    }
    return false;
  };

  const handleTranslate = async () => {
    if (!input.trim() || isTranslating) return;
    const keyReady = await ensureApiKey();
    if (!keyReady) return;
    setIsTranslating(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate the following text. If the input is in Chinese, translate it to English. If the input is in English, translate it to Chinese: ${input}`,
        config: { systemInstruction: "Output ONLY the raw translation." }
      });
      if (response.text) setInput(response.text.trim());
    } catch (err: any) {
      console.error("Translation failed:", err);
    } finally {
      setIsTranslating(false);
    }
  };

  const generateImageTool: FunctionDeclaration = {
    name: 'generate_image',
    description: 'Call this when user wants to create, draw, or synthesize a new image or video.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'High-detail descriptive prompt.' },
        aspect_ratio: { type: Type.STRING, enum: ['1:1', '16:9', '9:16'], description: 'Aspect ratio.' },
        media_type: { type: Type.STRING, enum: ['image', 'video'], description: 'Whether to generate an image or a video.' }
      },
      required: ['prompt']
    }
  };

  const handleStop = () => {
    isAbortedRef.current = true;
    setIsTyping(false);
    setStatusText('');
  };

  const callComfyUI = async (params: any, model: 'flux' | 'sdxl'): Promise<string> => {
    setStatusText(`${model.toUpperCase()}: Initiating...`);
    const url = ensureHttps(COMFY_SERVER_URL);
    const clientId = generateClientId();
    let workflow;
    if (model === 'flux') workflow = generateFluxWorkflow(params.prompt, 1024, 1024, 9, useLora);
    else workflow = generateSdxlWorkflow(params.prompt, "lowres, bad quality", 1024, 1024, 12, 3.5);
    const promptId = await queuePrompt(url, workflow, clientId);
    let progressCounter = 0;
    return new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        if (isAbortedRef.current) {
          clearInterval(poll);
          reject(new Error("Generation aborted by user"));
          return;
        }
        try {
          const history = await getHistory(url, promptId);
          if (history[promptId]) {
            const result = history[promptId];
            if (result.status.status_str === 'success') {
              clearInterval(poll);
              for (const key in result.outputs) {
                if (result.outputs[key].images?.length > 0) {
                  const img = result.outputs[key].images[0];
                  const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type);
                  
                  setStatusText(`${model.toUpperCase()}: Pre-fetching...`);
                  await preloadImage(imgUrl);
                  
                  resolve(imgUrl);
                  return;
                }
              }
              reject(new Error("No image data"));
            } else if (result.status.status_str === 'error') {
              clearInterval(poll);
              reject(new Error("Server error"));
            }
          } else {
            progressCounter = Math.min(progressCounter + 4, 98);
            setStatusText(`${model.toUpperCase()}: ${progressCounter}%`);
          }
        } catch (e) {
          clearInterval(poll);
          reject(e);
        }
      }, 1500);
    });
  };

  const callExternalEngine = async (params: any) => {
    const isVideo = params.media_type === 'video' || selectedDrawModel.startsWith('veo') || selectedDrawModel === 'sora2';
    const apiKey = externalKey || localStorage.getItem('external_api_key') || '';
    const baseUrl = externalBaseUrl || localStorage.getItem('external_base_url') || 'https://api.grsai.com';
    
    if (!apiKey) throw new Error("API Key missing. Configure in Studio Setup.");

    let endpoint = "";
    let payload: any = {};

    if (isVideo) {
        const isSora = selectedDrawModel === 'sora2';
        endpoint = isSora ? 'v1/video/sora-video' : 'v1/video/veo';
        
        const durationInt = parseInt(selectedVideoDuration.replace('s', ''));

        if (isSora) {
            payload = {
                model: "sora-2",
                prompt: params.prompt,
                url: params.firstFrameUrl || "",
                aspectRatio: params.aspect_ratio || "16:9",
                duration: durationInt,
                remixTargetId: "",
                characters: [],
                size: "small",
                resolution: selectedVideoResolution,
                webHook: "",
                shutProgress: false
            };
        } else {
            payload = {
                model: selectedDrawModel.startsWith('veo') ? selectedDrawModel : 'veo3.1-fast',
                prompt: params.prompt,
                firstFrameUrl: params.firstFrameUrl || "",
                lastFrameUrl: "",
                urls: params.urls || [],
                aspectRatio: params.aspect_ratio || "16:9",
                duration: durationInt,
                resolution: selectedVideoResolution,
                webHook: "",
                shutProgress: false
            };
        }
    } else {
        endpoint = 'v1/draw/nano-banana';
        payload = { 
            model: selectedDrawModel, 
            prompt: params.prompt, 
            aspectRatio: params.aspect_ratio || "auto", 
            imageSize: selectedDrawModel === 'nano-banana-pro' ? selectedResolution : "1K",
            urls: params.images && params.images.length > 0 ? params.images : undefined 
        };
    }

    setStatusText(`${selectedDrawModel.toUpperCase()}: Routing...`);

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, { 
      method: 'POST', 
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${apiKey}` 
      }, 
      body: JSON.stringify(payload) 
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || response.statusText);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let finalUrl = "";
    let buffer = "";

    if (reader) {
      while (true) {
        if (isAbortedRef.current) {
          reader.cancel();
          throw new Error("User stopped synthesis");
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";
        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine) continue;
          // Robust data: prefix removal
          const jsonStr = cleanLine.startsWith('data:') ? cleanLine.replace('data:', '').trim() : cleanLine;
          if (jsonStr === '[DONE]') break;
          try {
            const data = JSON.parse(jsonStr);
            if (data.progress !== undefined) {
              setStatusText(`${selectedDrawModel.toUpperCase()}: ${data.progress}%`);
            }
            // Broad search for result URL
            if (data.url) finalUrl = data.url;
            if (data.data?.url) finalUrl = data.data.url;
            if (data.results && data.results.length > 0 && data.results[0].url) {
              finalUrl = data.results[0].url;
            }
            if (data.status === 'succeeded' && data.url) finalUrl = data.url;
            if (data.error || data.status === 'failed') throw new Error(data.message || data.failure_reason || "Task Failed");
          } catch (e) {}
        }
      }
      
      // Process final buffer if loop terminated but buffer still has content
      if (buffer.trim() && !isAbortedRef.current) {
         const cleanLine = buffer.trim();
         const jsonStr = cleanLine.startsWith('data:') ? cleanLine.replace('data:', '').trim() : cleanLine;
         try {
           const data = JSON.parse(jsonStr);
           if (data.url) finalUrl = data.url;
           if (data.data?.url) finalUrl = data.data.url;
           if (data.results?.[0]?.url) finalUrl = data.results[0].url;
           if (data.status === 'succeeded' && data.url) finalUrl = data.url;
         } catch(e) {}
      }
    }

    if (!finalUrl && !isAbortedRef.current) throw new Error("No output URL received");
    
    setStatusText(`${selectedDrawModel.toUpperCase()}: Finishing...`);
    if (!isVideo) await preloadImage(finalUrl);

    return finalUrl;
  };

  const handleSend = async () => {
    if (!input.trim() && pendingImages.length === 0) return;
    if (isTyping) return;
    if (pendingImages.some(img => img.isLoading)) return;

    const keyReady = await ensureApiKey();
    if (!keyReady) return;

    isAbortedRef.current = false;
    const userText = input;
    const currentImages = [...pendingImages];
    const canvasRefIds = currentImages.filter(img => img.canvasItemId).map(img => img.canvasItemId!);
    let primaryModel = selectedModelMode === 'pro' ? 'gemini-3-pro-preview' : (selectedModelMode === 'vision' ? 'gemini-2.5-flash-image' : 'gemini-3-flash-preview');
    
    setInput('');
    setPendingImages([]);
    setMessages(prev => [...prev, { role: 'user', text: userText, images: currentImages.map(i => ({ url: i.url })) }]);
    setIsTyping(true);
    setStatusText('Thinking...');
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const userParts: any[] = currentImages.map(img => ({ inlineData: { mimeType: img.type, data: img.base64 } }));
      userParts.push({ text: userText });
      
      if (selectedModelMode === 'vision') {
        const response = await ai.models.generateContent({ model: primaryModel, contents: [{ role: 'user', parts: userParts }] });
        if (isAbortedRef.current) return;
        
        let imageUrl = "";
        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) imageUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        
        if (imageUrl) {
           setStatusText('VISION: Pre-fetching...');
           await preloadImage(imageUrl);
        }

        setMessages(prev => [...prev, { role: 'model', text: response.text || "Completed.", images: imageUrl ? [{ url: imageUrl }] : undefined, modelUsed: 'VISION' }]);
        if (imageUrl) window.dispatchEvent(new CustomEvent('add-image-to-canvas', { detail: { src: imageUrl, prompt: userText, parentIds: canvasRefIds } }));
        return;
      }
      
      const response = await ai.models.generateContent({
        model: primaryModel,
        contents: [{ role: 'user', parts: userParts }],
        config: {
          systemInstruction: "High-end Studio Orchestrator. Respond or call tools for imagery/video.",
          tools: [{ functionDeclarations: [generateImageTool] }]
        }
      });

      if (isAbortedRef.current) return;

      if (response.functionCalls && response.functionCalls.length > 0) {
        for (const fc of response.functionCalls) {
          const args = fc.args as any;
          const isDrawModelComfy = selectedDrawModel === 'flux' || selectedDrawModel === 'sdxl';
          const url = isDrawModelComfy ? await callComfyUI(args, selectedDrawModel) : await callExternalEngine({ ...args, firstFrameUrl: currentImages[0]?.url, urls: currentImages.map(i => i.base64) });
          
          if (isAbortedRef.current) return;
          
          setMessages(prev => [...prev, { role: 'model', text: `Synthesis finalized via ${selectedDrawModel.toUpperCase()}.`, images: [{ url }], modelUsed: selectedModelMode.toUpperCase() }]);
          window.dispatchEvent(new CustomEvent('add-image-to-canvas', { detail: { src: url, prompt: args.prompt, parentIds: canvasRefIds } }));
        }
      } else {
        if (isAbortedRef.current) return;
        setMessages(prev => [...prev, { role: 'model', text: response.text || "Acknowledged.", modelUsed: selectedModelMode.toUpperCase() }]);
      }
    } catch (error: any) {
      if (isAbortedRef.current) return;
      setMessages(prev => [...prev, { role: 'model', text: `Error: ${error.message}`, isError: true }]);
    } finally { 
        if (!isAbortedRef.current) {
          setIsTyping(false); 
          setStatusText(''); 
        }
    }
  };

  const getVideoDurations = (model: DrawModel): VideoDuration[] => {
    if (model === 'sora2') return ['10s', '15s'];
    if (model.startsWith('veo')) return ['4s', '6s', '8s'];
    return [];
  };

  return (
    <>
      {!isOpen && (
        <button onClick={() => setIsOpen(true)} className="fixed right-6 top-6 w-11 h-11 bg-white border border-slate-100 rounded-2xl shadow-premium flex items-center justify-center text-slate-400 transition-all hover:scale-105 z-[100] group hover:text-slate-950 active:scale-95">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-blue-500 rounded-full animate-pulse border-2 border-white" />
        </button>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/20 backdrop-blur-md" onClick={() => setIsSettingsOpen(false)} />
          <div className="relative w-full max-w-[320px] bg-white rounded-[28px] shadow-premium overflow-hidden animate-fade-in border border-slate-100 p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-[10px] font-black text-slate-950 tracking-widest uppercase">Studio Setup</h2>
              <button onClick={() => setIsSettingsOpen(false)} className="text-slate-300 hover:text-slate-950 transition-colors"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
            </div>
            <div className="space-y-6">
              {hasAistudio && (
                <div className="pb-4 border-b border-slate-100">
                  <button onClick={handleSelectApiKey} className="w-full flex items-center justify-center gap-3 py-3.5 bg-blue-50 text-blue-600 border border-blue-100 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-blue-100 transition-all active:scale-[0.98]">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3-3.5 3.5z"/></svg>
                    Link API Key
                  </button>
                </div>
              )}
              <div className="space-y-3">
                <input type="password" value={externalKey} onChange={e => setExternalKey(e.target.value)} placeholder="API KEY" className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-[10px] font-mono font-bold text-slate-950 focus:outline-none placeholder:text-slate-200" />
                <input type="text" value={externalBaseUrl} onChange={e => setExternalBaseUrl(e.target.value)} placeholder="ENDPOINT" className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-[10px] font-mono font-bold text-slate-950 focus:outline-none placeholder:text-slate-200" />
              </div>
              <button onClick={saveSettings} className="w-full py-3.5 bg-slate-950 text-white rounded-xl text-[9px] font-black tracking-[0.2em] uppercase hover:bg-black transition-all active:scale-[0.98]">Update Settings</button>
            </div>
          </div>
        </div>
      )}

      <div className={`fixed right-5 top-5 bottom-5 w-[310px] z-[100] transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] transform ${isOpen ? 'translate-x-0 opacity-100' : 'translate-x-[360px] opacity-0'}`}>
        <div className="w-full h-full glass-panel rounded-[28px] shadow-premium flex flex-col relative overflow-hidden border border-white/60 bg-white/85 backdrop-blur-[60px]">
          <div className="p-6 border-b border-slate-100/30 flex flex-col gap-5 bg-white/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-slate-950 rounded-xl flex items-center justify-center shadow-premium">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
                </div>
                <div>
                  <h3 className="text-[11px] font-black text-slate-950 uppercase tracking-[0.2em] leading-none">Studio Agent</h3>
                  <span className="text-[7px] font-black text-slate-300 uppercase tracking-[0.3em] mt-1.5 block leading-none">Neural Assistant</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setIsSettingsOpen(true)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:bg-white hover:text-slate-950 transition-all border border-transparent hover:border-slate-100"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
                <button onClick={() => setIsOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:bg-white hover:text-slate-950 transition-all border border-transparent hover:border-slate-100"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
              </div>
            </div>
            
            <div className="flex flex-col gap-3">
              <div className="flex bg-slate-100/60 p-1 rounded-xl gap-0.5 border border-slate-100/50">
                {(['auto', 'pro', 'vision'] as ModelMode[]).map(mode => (
                  <button key={mode} onClick={() => setSelectedModelMode(mode)} className={`flex-1 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-[0.1em] transition-all ${selectedModelMode === mode ? 'bg-white text-slate-950 shadow-soft border border-white' : 'text-slate-300 hover:text-slate-500'}`}>{mode}</button>
                ))}
              </div>
              <div className="flex bg-slate-100/60 p-1 rounded-xl gap-0.5 border border-slate-100/50">
                {(['flux', 'sdxl', 'nano-banana-pro', 'nano-banana-fast', 'veo3.1-fast', 'veo3.1-pro', 'sora2'] as DrawModel[]).map(dm => (
                  <button key={dm} onClick={() => setSelectedDrawModel(dm)} className={`flex-1 py-1.5 rounded-lg text-[7.5px] font-black uppercase tracking-tight transition-all ${selectedDrawModel === dm ? 'bg-slate-950 text-white shadow-soft' : 'text-slate-300 hover:text-slate-600'}`}>{dm.replace('nano-banana-', '').toUpperCase()}</button>
                ))}
              </div>

              {selectedDrawModel === 'nano-banana-pro' && (
                <div className="flex bg-slate-100/60 p-1 rounded-xl gap-0.5 border border-slate-100/50 animate-fade-in">
                  {(['1K', '2K', '4K'] as Resolution[]).map(res => (
                    <button key={res} onClick={() => setSelectedResolution(res)} className={`flex-1 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all ${selectedResolution === res ? 'bg-white text-slate-950 shadow-soft border border-white' : 'text-slate-300 hover:text-slate-500'}`}>{res}</button>
                  ))}
                </div>
              )}

              {(selectedDrawModel.startsWith('veo') || selectedDrawModel === 'sora2') && (
                <div className="flex flex-col gap-2 mt-1 animate-fade-in">
                   <div className="flex items-center justify-between px-1">
                      <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Duration</span>
                   </div>
                   <div className="flex bg-slate-100/60 p-1 rounded-xl gap-0.5 border border-slate-100/50">
                      {getVideoDurations(selectedDrawModel).map(d => (
                        <button 
                          key={d} 
                          onClick={() => setSelectedVideoDuration(d as VideoDuration)} 
                          className={`flex-1 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all ${selectedVideoDuration === d ? 'bg-slate-900 text-white shadow-soft' : 'text-slate-300 hover:text-slate-600'}`}
                        >
                          {d}
                        </button>
                      ))}
                   </div>

                   <div className="flex items-center justify-between px-1 mt-1">
                      <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Quality</span>
                   </div>
                   <div className="flex bg-slate-100/60 p-1 rounded-xl gap-0.5 border border-slate-100/50">
                      {(['720p', '1080p'] as VideoResolution[]).map(r => (
                        <button 
                          key={r} 
                          onClick={() => setSelectedVideoResolution(r)} 
                          className={`flex-1 py-1.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-all ${selectedVideoResolution === r ? 'bg-slate-900 text-white shadow-soft' : 'text-slate-300 hover:text-slate-600'}`}
                        >
                          {r}
                        </button>
                      ))}
                   </div>
                </div>
              )}

              {selectedDrawModel === 'flux' && (
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50/50 rounded-xl border border-slate-100/50 animate-fade-in">
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Enable Cartoon LoRA</span>
                  <button onClick={() => setUseLora(!useLora)} className={`w-9 h-5 rounded-full p-1 transition-all ${useLora ? 'bg-blue-500' : 'bg-slate-200'}`}>
                    <div className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-all ${useLora ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 space-y-6 bg-slate-50/10">
            {messages.map((msg, i) => (
              <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-fade-in`}>
                <div className={`max-w-[95%] p-4 rounded-[20px] text-[12px] font-bold leading-relaxed relative shadow-sm ${msg.role === 'user' ? 'bg-slate-950 text-white' : 'bg-white border border-slate-100 text-slate-800'}`}>
                  {msg.modelUsed && <span className="absolute -top-4 left-0 text-[7px] font-black uppercase text-slate-300 tracking-[0.2em]">{msg.modelUsed}</span>}
                  <div className="whitespace-pre-wrap tracking-tight">{msg.text}</div>
                  {msg.images?.map((img, idx) => (
                    <div key={idx} className="mt-3 relative overflow-hidden rounded-xl border border-slate-100 shadow-soft">
                        {isVideoUrl(img.url) ? (
                            <video src={img.url} className="w-full object-cover max-h-[220px]" muted playsInline autoPlay loop />
                        ) : (
                            <img 
                              src={img.url} 
                              className="w-full object-cover max-h-[220px]" 
                              alt="content" 
                              decoding="async"
                            />
                        )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex flex-col gap-1.5 ml-1">
                <div className="flex gap-1">
                  <div className="w-1 h-1 bg-slate-300 rounded-full animate-bounce" />
                  <div className="w-1 h-1 bg-slate-300 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-1 h-1 bg-slate-300 rounded-full animate-bounce [animation-delay:-0.3s]" />
                </div>
                {statusText && <span className="text-[7px] font-black text-slate-300 uppercase tracking-[0.3em] animate-pulse">{statusText}</span>}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-6 bg-white/50 border-t border-slate-100/30 backdrop-blur-3xl">
            {pendingImages.length > 0 && (
              <div className="flex gap-2.5 mb-4 overflow-x-auto no-scrollbar py-1">
                {pendingImages.map((img, idx) => (
                  <div key={idx} className="relative shrink-0 group">
                    <img src={img.url} className={`w-12 h-12 rounded-xl object-cover border border-white shadow-soft ${img.isLoading ? 'opacity-50 blur-[1px]' : ''}`} alt="pending" />
                    <button onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== idx))} className="absolute -top-1.5 -right-1.5 bg-slate-950 text-white rounded-full w-4.5 h-4.5 flex items-center justify-center shadow-lg border-2 border-white transition-all"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                  </div>
                ))}
              </div>
            )}
            
            <div className="flex items-end gap-2 bg-white border border-slate-100 p-1.5 rounded-[22px] shadow-premium">
              <button onClick={() => fileInputRef.current?.click()} className="w-9 h-9 flex items-center justify-center text-slate-300 hover:text-slate-950 transition-all rounded-full mb-0.5"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
              
              <textarea 
                ref={textareaRef} 
                placeholder="Instruct..." 
                value={input} 
                onChange={e => setInput(e.target.value)} 
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), isTyping ? handleStop() : handleSend())} 
                className="flex-1 bg-transparent border-none focus:outline-none text-[12px] font-bold text-slate-950 placeholder:text-slate-200 resize-none py-3 leading-relaxed tracking-tight" 
                style={{ maxHeight: '140px', minHeight: '44px' }} 
              />
              
              <div className="flex flex-col gap-1.5 mb-0.5">
                <button onClick={handleTranslate} disabled={!input.trim() || isTyping} className="w-9 h-9 flex items-center justify-center text-slate-300 hover:text-blue-500 transition-all active:scale-90 disabled:opacity-5 rounded-full"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 8l6 6M4 14l10-10M2 5h12M7 2h1M22 22l-5-10-5 10M12.8 18h8.4" /></svg></button>
                {isTyping ? (
                  <button onClick={handleStop} className="w-9 h-9 bg-rose-500 rounded-full flex items-center justify-center text-white shadow-premium animate-pulse transition-all hover:bg-rose-600 active:scale-95" title="Stop Synthesis">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                  </button>
                ) : (
                  <button onClick={handleSend} disabled={!input.trim() && pendingImages.length === 0} className="w-9 h-9 bg-slate-950 rounded-full flex items-center justify-center text-white shadow-premium transition-all hover:bg-black active:scale-95 disabled:opacity-5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><path d="M5 12l7-7 7 7M12 19V5"/></svg>
                  </button>
                )}
              </div>
            </div>
            
            <input type="file" id="chat-file-input" ref={fileInputRef} className="hidden" multiple onChange={e => {
                const files = Array.from(e.target.files || []) as File[];
                files.forEach(f => {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const base64 = (ev.target?.result as string).split(',')[1];
                    setPendingImages(prev => [...prev, { url: ev.target?.result as string, base64, type: f.type, isLoading: false }]);
                  };
                  reader.readAsDataURL(f);
                });
              }} 
            />
          </div>
        </div>
      </div>
    </>
  );
};

export default GeminiChat;
