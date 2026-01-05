
import React, { useState } from 'react';
import InfiniteCanvasTab from './components/features/InfiniteCanvasTab';
import GeminiChat from './components/features/GeminiChat';

const App = () => {
  const [serverUrl, setServerUrl] = useState('https://17610400098.top');

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#f8fafc] relative selection:bg-blue-500/30 selection:text-blue-900">
      {/* Ghostly Atmospheric Glows - Daylight/Studio Theme */}
      <div className="absolute top-[-20%] right-[-10%] w-[1200px] h-[1200px] rounded-full bg-blue-100/60 blur-[120px] pointer-events-none z-0 animate-pulse" />
      <div className="absolute bottom-[-20%] left-[-10%] w-[1000px] h-[1000px] rounded-full bg-indigo-100/60 blur-[100px] pointer-events-none z-0" />
      <div className="absolute top-[30%] left-[40%] w-[600px] h-[600px] rounded-full bg-purple-100/40 blur-[80px] pointer-events-none z-0 animate-float" />
      
      {/* Invisible Architectural Grid */}
      <div className="absolute inset-0 architectural-grid opacity-[0.04] z-0 pointer-events-none" />
      
      {/* Main Canvas Layer */}
      <InfiniteCanvasTab serverUrl={serverUrl} setServerUrl={setServerUrl} />
      
      {/* AI Assistant Overlay */}
      <GeminiChat />
      
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
          animation: fadeIn 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .architectural-grid {
           pointer-events: none;
           background-image: radial-gradient(#94a3b8 1px, transparent 1px);
           background-size: 60px 60px;
        }
      `}</style>
    </div>
  );
};

export default App;
