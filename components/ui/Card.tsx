import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  icon?: React.ReactNode;
}

const Card: React.FC<CardProps> = ({ children, className = '', title, icon }) => {
  return (
    <div className={`glass-panel rounded-3xl p-8 transition-all duration-500 hover:shadow-2xl ${className}`}>
      {(title || icon) && (
        <div className="flex items-center gap-3 mb-6 border-b border-gray-100/50 pb-4">
          {icon && <span className="text-2xl text-primary">{icon}</span>}
          {title && <h2 className="text-xl font-semibold text-gray-800 tracking-tight">{title}</h2>}
        </div>
      )}
      <div className="animate-fade-in">
        {children}
      </div>
    </div>
  );
};

export default Card;
