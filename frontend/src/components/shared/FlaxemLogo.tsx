import React from "react";
import fseDmsLogo from "@/assets/images/dmslogo5.jpeg";

interface FlaxemLogoProps {
  className?: string;
  variant?: "light" | "dark";
  compact?: boolean;
}

export const FlaxemLogo: React.FC<FlaxemLogoProps> = ({
  className = "h-12 w-[148px]",
  variant = "light",
  compact = false,
}) => {
  const isLight = variant === "light";

  return (
    <div className={`flex items-center ${className}`} aria-label="FSE DMS">
      <div
        className={`flex h-full items-center justify-center overflow-hidden ${
          compact ? "w-12 px-1" : "w-full px-2.5"
        } ${isLight ? "bg-white" : "border border-[#D7DCE0] bg-white"}`}
      >
        <img
          src={fseDmsLogo}
          alt="FSE Document Management System"
          className={
            compact
              ? "h-full w-full object-contain"
              : "h-full w-full object-contain"
          }
        />
      </div>
    </div>
  );
};
