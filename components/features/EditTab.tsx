
import React, { useState, useRef, useEffect } from 'react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { TextArea } from '../ui/Input';
import Slider from '../ui/Slider';
import { ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId, uploadImage, getLogs, parseConsoleProgress } from '../../services/api';
import { generateEditWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

interface EditTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

type EditMode = 'qwen' | 'nano-banana-pro' | 'nano-banana-fast';

const EditTab: React.FC<EditTabProps> = ({ serverUrl, setServerUrl: _ }) => {
  const [prompt, setPrompt] = useState('修改姿势敞开衣服露出诱人的胸部 穿着黑丝内衣');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(2.5);
  const [mode, setMode] = useState<EditMode>('qwen');
  
  const [status, setStatus] = useState<GenerationStatus>({
    isGenerating: false,
    progress: 0,
    statusText: '',
  });

  const pollInterval = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0];
      setFile(f);
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target?.result as string);
      reader.readAsDataURL(f);
    }
  };

  const handleGenerate = async () => {
    if (!file) {
      setStatus(prev => ({ ...prev, error: 'Please upload an image first' }));
      return;
    }
    
    setStatus({ isGenerating: true, progress: 5, statusText: 'Initializing...', imageUrl: undefined, error: undefined });
    
    try {
      if (mode.includes('nano-banana')) {
        // --- Grsai Nano Banana Integration ---
        const apiKey = localStorage.getItem('gemini_api_key') || '';
        const baseUrl = localStorage.getItem('gemini_api_base') || 'https://api.grsai.com';
        
        // Convert file to base64
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });

        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/draw/nano-banana`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${apiKey}` 
          },
          body: JSON.stringify({ 
            model: mode, 
            prompt: prompt, 
            aspectRatio: "auto", 
            imageSize: "1K",
            urls: [base64] 
          })
        });

        if (!response.ok) throw new Error(`Grsai API Error: ${response.status}`);

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let finalImageUrl = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const lines = decoder.decode(value).split('\n');
            for (const line of lines) {
              const cleanLine = line.trim();
              if (!cleanLine.startsWith('data:')) continue;
              const jsonStr = cleanLine.replace('data:', '').trim();
              if (jsonStr === '[DONE]') break;
              try {
                const data = JSON.parse(jsonStr);
                if (data.progress !== undefined) {
                  setStatus(prev => ({ ...prev, progress: data.progress, statusText: `Generating... ${data.progress}%` }));
                }
                if (data.results?.[0]?.url) finalImageUrl = data.results[0].url;
              } catch (e) {}
            }
          }
        }

        if (finalImageUrl) {
          setStatus({ isGenerating: false, progress: 100, statusText: 'Completed', imageUrl: finalImageUrl });
        } else {
          throw new Error("No output image received from Grsai");
        }
        return;
      }

      // --- Default Qwen/ComfyUI Workflow ---
      const url = ensureHttps(serverUrl);
      if (!url) throw new Error("Server URL is not configured");

      const imageName = await uploadImage(url, file);
      setStatus(prev => ({ ...prev, progress: 15, statusText: 'Processing Workflow...' }));
      
      const clientId = generateClientId();
      const workflow = generateEditWorkflow(prompt, imageName, steps, cfg);
      const promptId = await queuePrompt(url, workflow, clientId);
      
      let fakeProgress = 15;
      pollInterval.current = window.setInterval(async () => {
        try {
          const history = await getHistory(url, promptId);
          if (history[promptId]) {
            const result = history[promptId];
            if (result.status.status_str === 'success') {
               const outputs = result.outputs;
               for (const key in outputs) {
                 if (outputs[key].images && outputs[key].images.length > 0) {
                   const img = outputs[key].images[0];
                   const imgUrl = getImageUrl(url, img.filename, img.subfolder, img.type);
                   setStatus({ isGenerating: false, progress: 100, statusText: 'Completed', imageUrl: imgUrl });
                   if (pollInterval.current) clearInterval(pollInterval.current);
                   return;
                 }
               }
            } else if (result.status.status_str === 'error') {
               throw new Error(result.status.error || 'Workflow failed');
            }
          }
          
          const logs = await getLogs(url);
          const parsed = parseConsoleProgress(logs);
          if (parsed > 0) {
            setStatus(prev => ({ ...prev, progress: parsed, statusText: `Sampling... ${parsed}%` }));
          } else {
            fakeProgress = Math.min(fakeProgress + 2, 95);
            setStatus(prev => ({ ...prev, progress: fakeProgress, statusText: 'Processing...' }));
          }

        } catch (e: any) {
           console.error(e);
        }
      }, 1000);

    } catch (e: any) {
      setStatus({ isGenerating: false, progress: 0, statusText: '', error: e.message });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 max-w-[1600px] mx-auto p-8 animate-fade-in">
      <div className="lg:col-span-4 space-y-6">
        <Card title="Edit Studio" icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}>
          
          {/* Model Switcher */}
          <div className="mb-6">
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 ml-1">Edit Engine</label>
            <div className="flex bg-slate-100 p-1.5 rounded-[20px] gap-1 shadow-inner border border-slate-200/50">
              {(['qwen', 'nano-banana-pro', 'nano-banana-fast'] as EditMode[]).map(m => (
                <button 
                  key={m} 
                  onClick={() => setMode(m)} 
                  className={`flex-1 py-2.5 text-[9px] font-black rounded-2xl transition-all ${mode === m ? 'bg-white text-slate-950 shadow-md scale-100 border border-slate-100' : 'text-slate-400 hover:text-slate-600 scale-95'}`}
                >
                  {m === 'qwen' ? 'QWEN 2509' : m.replace('nano-banana-', '').toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-6">
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 ml-1">Source Image</label>
            <div className={`group relative border-2 border-dashed rounded-[32px] overflow-hidden transition-all duration-500 ${preview ? 'border-primary/20 bg-slate-50' : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'}`}>
              <input type="file" id="img-upload" className="hidden" accept="image/*" onChange={handleFileChange} />
              <label htmlFor="img-upload" className="cursor-pointer w-full h-full block">
                {preview ? (
                  <div className="relative group/preview p-4">
                    <img src={preview} alt="Preview" className="max-h-64 mx-auto rounded-2xl shadow-xl transition-transform duration-500 group-hover/preview:scale-[1.02]" />
                    <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm opacity-0 group-hover/preview:opacity-100 transition-opacity flex items-center justify-center rounded-2xl">
                      <span className="text-white text-[10px] font-black uppercase tracking-[0.2em]">Change Image</span>
                    </div>
                  </div>
                ) : (
                  <div className="py-16 text-center space-y-4">
                    <div className="w-16 h-16 bg-white rounded-3xl shadow-xl flex items-center justify-center mx-auto text-slate-400 transition-transform group-hover:scale-110">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                    </div>
                    <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Drop image here or click</span>
                  </div>
                )}
              </label>
            </div>
          </div>

          <TextArea 
            label="Modification Prompt" 
            value={prompt} 
            onChange={e => setPrompt(e.target.value)} 
            rows={4} 
            placeholder="What should be changed?"
            className="rounded-[24px] bg-slate-50 border-slate-100 font-bold text-sm tracking-tight text-slate-800"
          />
          
          {mode === 'qwen' && (
            <div className="space-y-4 animate-fade-in">
              <Slider label="Steps" min={10} max={100} step={5} value={steps} onChange={e => setSteps(Number(e.target.value))} />
              <Slider label="CFG Scale" min={0.5} max={10} step={0.5} value={cfg} onChange={e => setCfg(Number(e.target.value))} />
            </div>
          )}

          <Button 
            onClick={handleGenerate} 
            loading={status.isGenerating}
            className="!rounded-[24px] !py-5 !bg-slate-950 hover:!bg-black shadow-2xl transition-all"
          >
            Apply Modification
          </Button>
          
          {status.error && (
            <div className="mt-4 p-4 bg-rose-50 text-rose-600 text-[11px] font-black uppercase tracking-widest rounded-2xl border border-rose-100 flex items-center gap-3">
               <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
               {status.error}
            </div>
          )}
        </Card>
      </div>

      <div className="lg:col-span-8">
        <Card className="h-full min-h-[700px] flex flex-col relative" title="Masterpiece Result">
          {status.isGenerating && (
             <div className="mb-10 space-y-3 z-10">
               <div className="flex justify-between text-[10px] font-black text-slate-400 uppercase tracking-widest">
                 <span>{status.statusText}</span>
                 <span className="font-mono">{Math.round(status.progress)}%</span>
               </div>
               <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                 <div className="h-full bg-slate-950 transition-all duration-700 ease-out" style={{ width: `${status.progress}%` }}></div>
               </div>
             </div>
          )}

          <div className="flex-1 rounded-[40px] border border-slate-100 bg-slate-50 flex items-center justify-center relative overflow-hidden group shadow-inner">
             {status.imageUrl ? (
               <div className="relative w-full h-full p-8 flex items-center justify-center">
                 <img src={status.imageUrl} alt="Result" className="max-w-full max-h-full object-contain shadow-[0_40px_100px_rgba(0,0,0,0.2)] rounded-[32px] transition-transform duration-700 group-hover:scale-[1.01]" />
                 <div className="absolute top-12 right-12 flex flex-col gap-3 opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                    <a href={status.imageUrl} download="edited-studio.png" className="w-12 h-12 bg-white rounded-2xl shadow-2xl flex items-center justify-center text-slate-900 hover:scale-110 active:scale-95 transition-all">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    </a>
                 </div>
               </div>
             ) : (
               <div className="text-center space-y-6">
                  <div className="w-24 h-24 bg-white rounded-[40px] shadow-2xl flex items-center justify-center mx-auto text-slate-100 mb-8">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  </div>
                  <div>
                    <h4 className="text-sm font-black text-slate-900 uppercase tracking-widest">Waiting for canvas</h4>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-2">Adjust settings and apply modification</p>
                  </div>
               </div>
             )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default EditTab;
