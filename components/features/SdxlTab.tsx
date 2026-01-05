import React, { useState, useRef, useEffect } from 'react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { TextArea } from '../ui/Input';
import Slider from '../ui/Slider';
import { ensureHttps, queuePrompt, getHistory, getImageUrl, generateClientId } from '../../services/api';
import { generateSdxlWorkflow } from '../../services/workflows';
import { GenerationStatus } from '../../types';

interface SdxlTabProps {
  serverUrl: string;
  setServerUrl: (url: string) => void;
}

const SdxlTab: React.FC<SdxlTabProps> = ({ serverUrl, setServerUrl: _ }) => {
  const [positive, setPositive] = useState('1girl, 18 yo, solo, long hair, looking at viewer, smile...');
  const [negative, setNegative] = useState('bad quality, worst quality, lowres...');
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(720);
  const [steps, setSteps] = useState(10);
  const [cfg, setCfg] = useState(2.5);
  
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
      setStatus(prev => ({ ...prev, error: 'Please enter server URL' }));
      return;
    }
    
    setStatus({ isGenerating: true, progress: 0, statusText: 'Initializing...', imageUrl: undefined, error: undefined });
    
    try {
      const clientId = generateClientId();
      const workflow = generateSdxlWorkflow(positive, negative, width, height, steps, cfg);
      const promptId = await queuePrompt(url, workflow, clientId);
      
      let fakeProgress = 0;
      
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
               throw new Error(result.status.error || 'SDXL Error');
            }
          }
          
          fakeProgress = Math.min(fakeProgress + 5, 95);
          setStatus(prev => ({ ...prev, progress: fakeProgress, statusText: 'Generating...' }));

        } catch (e: any) {
           console.error(e);
        }
      }, 1000);

    } catch (e: any) {
      setStatus({ isGenerating: false, progress: 0, statusText: '', error: e.message });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <div className="lg:col-span-4 space-y-6">
        <Card title="SDXL Settings" icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>}>
          <TextArea label="Positive Prompt" value={positive} onChange={e => setPositive(e.target.value)} rows={4} />
          <TextArea label="Negative Prompt" value={negative} onChange={e => setNegative(e.target.value)} rows={3} />
          
          <div className="grid grid-cols-2 gap-4">
             <Slider label="Width" min={512} max={2048} step={64} value={width} onChange={e => setWidth(Number(e.target.value))} />
             <Slider label="Height" min={512} max={2048} step={64} value={height} onChange={e => setHeight(Number(e.target.value))} />
          </div>

          <Slider label="Steps" min={10} max={100} step={1} value={steps} onChange={e => setSteps(Number(e.target.value))} />
          <Slider label="CFG Scale" min={1} max={30} step={0.5} value={cfg} onChange={e => setCfg(Number(e.target.value))} />

          <Button onClick={handleGenerate} loading={status.isGenerating} className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-indigo-500/30">
            Generate SDXL
          </Button>

          {status.error && (
            <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg border border-red-100">
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
                 <div className="h-full bg-indigo-500 transition-all duration-300 ease-out" style={{ width: `${status.progress}%` }}></div>
               </div>
             </div>
          )}

          <div className="flex-1 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 flex items-center justify-center relative overflow-hidden">
             {status.imageUrl ? (
               <img src={status.imageUrl} alt="Result" className="max-w-full max-h-[700px] object-contain shadow-2xl rounded-lg" />
             ) : (
               <div className="text-center text-gray-400">
                  <p className="font-medium">SDXL Result</p>
               </div>
             )}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SdxlTab;