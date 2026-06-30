import React from "react";
import fseLogo from "@/assets/images/fselogo.png";

interface FlaxemLogoProps {
  className?: string;
  variant?: "light" | "dark";
  compact?: boolean;
}

export const FlaxemLogo: React.FC<FlaxemLogoProps> = ({
  className = "h-11 w-[118px]",
  variant = "light",
  compact = false,
}) => {
  const isLight = variant === "light";

  return (
    <div className={`flex items-center ${className}`} aria-label="FSE DMS">
      <div
        className={`flex h-full items-center overflow-hidden border ${
          compact ? "w-12 justify-center" : "w-full gap-2 px-2.5"
        } ${isLight ? "border-white/20 bg-white" : "border-[#D7DCE0] bg-white"}`}
      >
        <div className="relative h-9 w-16 shrink-0 overflow-hidden">
          <img
            src={fseLogo}
            alt="Flaxem System Enterprises"
            className="absolute left-1/2 top-1/2 h-[82px] w-[82px] max-w-none -translate-x-1/2 -translate-y-[45%] object-cover object-[50%_30%]"
          />
        </div>
        {!compact && (
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#D71932]">
            DMS
          </span>
        )}
      </div>
    </div>
  );
};
