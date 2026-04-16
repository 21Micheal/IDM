// Flaxem System Enterprises Ltd - FSE Logo
// Corporate branding: Blue and Red
import React from 'react';

interface FlaxemLogoProps {
  className?: string;
  variant?: 'light' | 'dark';
}

export const FlaxemLogo: React.FC<FlaxemLogoProps> = ({ className = "h-10 w-auto", variant = 'light' }) => {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* FSE Logo - Blue and Red */}
      <svg width="48" height="32" viewBox="0 0 48 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-full w-auto">
        {/* Blue FSE background shape */}
        <path d="M0 8L12 0H28L16 8H0Z" fill="#0066CC"/>
        <path d="M8 8L20 0H36L24 8H8Z" fill="#0066CC"/>
        <path d="M16 8L28 0H44L32 8H16Z" fill="#0066CC"/>
        
        <path d="M0 16L8 8H24L16 16H0Z" fill="#0066CC"/>
        <path d="M12 16L28 0H40L24 16H12Z" fill="#0066CC"/>
        
        <path d="M0 24L12 16H28L16 24H0Z" fill="#0066CC"/>
        <path d="M8 24L20 16H36L24 24H8Z" fill="#0066CC"/>
        <path d="M24 24L36 16H48L40 24H24Z" fill="#FF2E2E"/>
        
        <path d="M12 32L24 24H40L28 32H12Z" fill="#0066CC"/>
        <path d="M32 32L44 24H48L40 32H32Z" fill="#FF2E2E"/>
      </svg>
      
      {/* Text: Flaxem | DMS */}
      <div className="flex flex-col">
        <span className={`text-sm font-bold tracking-tight ${
          variant === 'light' ? 'text-white' : 'text-slate-900'
        }`}>
          Flaxem
        </span>
        <span className="text-xs font-semibold tracking-wide text-red-600">
          | IDM
        </span>
      </div>
    </div>
  );
};