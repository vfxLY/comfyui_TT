import React from 'react';

interface SliderProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  valueDisplay?: string | number;
}

const Slider: React.FC<SliderProps> = ({ label, valueDisplay, className = '', ...props }) => {
  return (
    <div className="mb-5">
      <div className="flex justify-between items-center mb-2 ml-1">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {label}
        </label>
        <span className="text-sm font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md">
          {valueDisplay ?? props.value}
        </span>
      </div>
      <div className="relative h-6 flex items-center">
        <input
          type="range"
          className={`w-full absolute z-20 opacity-0 cursor-pointer h-full ${className}`}
          {...props}
        />
        <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden absolute z-10">
          <div 
            className="h-full bg-primary transition-all duration-100"
            style={{ 
              width: `${((Number(props.value) - Number(props.min)) / (Number(props.max) - Number(props.min))) * 100}%` 
            }}
          />
        </div>
        <div 
            className="h-5 w-5 bg-white border border-gray-200 shadow-md rounded-full absolute z-10 pointer-events-none transition-all duration-100"
            style={{ 
               left: `calc(${((Number(props.value) - Number(props.min)) / (Number(props.max) - Number(props.min))) * 100}% - 10px)`
            }}
        />
      </div>
    </div>
  );
};

export default Slider;
