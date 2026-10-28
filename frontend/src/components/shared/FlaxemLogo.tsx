import React from "react";
import fseDmsLogo from "@/assets/images/FSEDMSlogo.png";

interface FlaxemLogoProps {
  className?: string;
  variant?: "light" | "dark";
  compact?: boolean;
}

export const FlaxemLogo: React.FC<FlaxemLogoProps> = ({
  className = "h-[50px] w-auto",
  variant = "light",
  compact = false,
}) => {
  return (
    <div className={`flex items-center justify-center ${className}`} aria-label="FSE DMS">
      <img
        src={fseDmsLogo}
        alt="FSE Document Management System"
        className={
          compact
            ? "h-8 w-8 object-contain"
            : "h-full w-auto max-h-full max-w-[180px] object-contain"
        }
      />
    </div>
  );
};

