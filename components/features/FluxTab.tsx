import React, { useState, useRef, useEffect } from 'react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { Input, TextArea } from '../ui/Input';
import Slider from '../ui/Slider';
import { ensureHttps, queuePrompt, getHistory, getLogs, parseConsoleProgress, getImageUrl, generateClientId } from '../../services/api';
import { generateFluxWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

interface FluxTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

const FluxTab: React.FC<FluxTabProps> = ({ serverUrl, setServerUrl }) => {
  const [prompt, setPrompt] = useState(`在金庸《神雕侠侣》原著剧情中...
(Default long prompt truncated for brevity)`);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [steps, setSteps] = useState(9);
  const [enableLora, setEnableLora] = useState(true);
  
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

  const handleGenerate = async () => {
    const url = ensureHttps(serverUrl);
    if (!url) {
      setStatus(prev => ({ ...prev, error: 'Please enter a server URL' }));
      return;
    }
    
    setStatus({ isGenerating: true, progress: 0, statusText: 'Initializing...', imageUrl: undefined, error: undefined });
    
    try {
      const clientId = generateClientId();
      const workflow = generateFluxWorkflow(prompt, width, height, steps, enableLora);
      const promptId = await queuePrompt(url, workflow, clientId);
      
      let fakeProgress = 0;
      
      pollInterval.current = window.setInterval(async () => {
        try {
          // Check history for completion
          const history = await getHistory(url, promptId);
          if (history[promptId]) {
            const result = history[promptId];
            if (result.status.status_str === 'success') {
               // Find image output
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
               throw new Error('Workflow failed on server');
            }
          }

          // Check logs for progress
          // Note: This is experimental as parsing logs is brittle
          const logs = await getLogs(url); 
          const parsed = parseConsoleProgress(logs);
          if (parsed > 0) {
             setStatus(prev => ({ ...prev, progress: parsed, statusText: `Sampling... ${parsed}%` }));
          } else {
             // Fake progress fallback
             fakeProgress = Math.min(fakeProgress + 2, 95);
             setStatus(prev => ({ ...prev, progress: fakeProgress, statusText: 'Processing...' }));
          }

        } catch (e: any) {
          console.error(e);
          // Don't abort immediately on poll fail, might be transient
        }
      }, 1000);

    } catch (e: any) {
      setStatus({ isGenerating: false, progress: 0, statusText: '', error: e.message });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-4 space-y-6">
        <Card title="Configuration" icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>}>
          <div className="hidden">
             <Input label="Server URL" value={serverUrl} onChange={e => setServerUrl(e.target.value)} />
          </div>
          
          <TextArea 
            label="Prompt" 
            value={prompt} 
            onChange={e => setPrompt(e.target.value)} 
            rows={6}
            className="text-sm font-mono"
          />

          <div className="flex items-center justify-between p-4 bg-white/40 rounded-xl border border-white/60 mb-6">
            <span className="text-sm font-medium text-gray-700">Enable Cartoon LoRA</span>
            <button 
              onClick={() => setEnableLora(!enableLora)}
              className={`w-12 h-6 rounded-full p-1 transition-colors duration-300 ${enableLora ? 'bg-primary' : 'bg-gray-300'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white shadow-md transform transition-transform duration-300 ${enableLora ? 'translate-x-6' : 'translate-x-0'}`} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <Slider label="Width" min={512} max={4096} step={64} value={width} onChange={e => setWidth(Number(e.target.value))} />
             <Slider label="Height" min={512} max={4096} step={64} value={height} onChange={e => setHeight(Number(e.target.value))} />
          </div>

          <Slider label="Steps" min={1} max={50} value={steps} onChange={e => setSteps(Number(e.target.value))} />

          <Button onClick={handleGenerate} loading={status.isGenerating}>
            Generate Image
          </Button>

          {status.error && (
            <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100 flex items-center gap-2">
               <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
               {status.error}
            </div>
          )}
        </Card>
      </div>

      <div className="lg:col-span-8">
        <Card className="h-full min-h-[600px] flex flex-col" title="Result">
          {status.isGenerating && (
             <div className="mb-6 space-y-2">
               <div className="flex justify-between text-xs font-semibold text-gray-500 uppercase">
                 <span>{status.statusText}</span>
                 <span>{Math.round(status.progress)}%</span>
               </div>
               <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                 <div className="h-full bg-primary transition-all duration-300 ease-out" style={{ width: `${status.progress}%` }}></div>
               </div>
             </div>
          )}

          <div className="flex-1 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 flex items-center justify-center relative overflow-hidden group">
             {status.imageUrl ? (
               <>
                 <img src={status.imageUrl} alt="Generated" className="max-w-full max-h-[700px] object-contain shadow-2xl rounded-lg transition-transform duration-500 group-hover:scale-[1.01]" />
                 <a href={status.imageUrl} download="flux-generated.png" className="absolute top-4 right-4 bg-white/90 p-2 rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white text-gray-700">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                 </a>
               </>
             ) : (
               <div className="text-center text-gray-400">
                  <svg className="w-20 h-20 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                  <p className="font-medium">Ready to generate</p>
               </div>
             )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default FluxTab;