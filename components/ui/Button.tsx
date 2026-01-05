import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'outline';
}

const Button: React.FC<ButtonProps> = ({ 
  children, 
  loading, 
  variant = 'primary', 
  className = '', 
  ...props 
}) => {
  const baseStyles = "relative w-full py-3.5 px-6 rounded-2xl font-semibold text-sm transition-all duration-300 transform active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none flex items-center justify-center gap-2 overflow-hidden group";
  
  const variants = {
    primary: "bg-primary text-white shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 hover:bg-blue-600",
    secondary: "bg-slate-800 text-white shadow-lg shadow-slate-500/30 hover:bg-slate-900",
    outline: "bg-transparent border border-gray-300 text-gray-700 hover:bg-gray-50",
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${className}`} 
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? (
        <>
          <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-current opacity-80" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>Processing...</span>
        </>
      ) : (
        children
      )}
      
      {!loading && variant === 'primary' && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700 ease-in-out"></div>
      )}
    </button>
  );
};

export default Button;
