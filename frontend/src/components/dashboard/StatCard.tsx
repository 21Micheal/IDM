import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from "../../lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  trend?: {
    value: number;
    isPositive: boolean;
    direction?: 'up' | 'down' | 'flat';
    suffix?: string;
    label?: string;
  };
  /** Indigo Vault semantic variants */
  color?: 'primary' | 'accent' | 'teal' | 'secondary';
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
}

const iconWrapVariants: Record<NonNullable<StatCardProps['color']>, string> = {
  primary: 'bg-primary/7 text-primary',
  accent: 'bg-accent/10 text-accent',
  teal: 'bg-teal/10 text-teal',
  secondary: 'bg-primary/7 text-primary',
};

function formatTrendValue(value: number) {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) return '0';
  return Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
}

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  trend,
  color = 'primary',
  href,
  onClick,
}) => {
  const trendDirection = trend?.direction ?? (trend?.isPositive ? 'up' : 'down');
  const TrendIcon =
    trendDirection === 'up'
      ? ArrowUpRight
      : trendDirection === 'down'
        ? ArrowDownRight
        : ArrowRight;

  const cardContent = (
    <div
      className="group h-full border border-[#C8CDD2] bg-white p-4 transition-colors duration-200 hover:bg-[#F5F7F8]"
    >
      <div className="flex min-h-[5.75rem] flex-col justify-between">
        <div className="flex items-start justify-between gap-4">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center border transition-colors",
              iconWrapVariants[color],
            )}
          >
            <Icon className="h-[18px] w-[18px] stroke-[2]" />
          </div>

          {trend && (
            <div
              className={cn(
                "flex items-center gap-1 text-xs font-semibold",
                trend.isPositive ? "text-teal" : "text-destructive"
              )}
              title={trend.label}
              aria-label={trend.label}
            >
              <TrendIcon className="h-3.5 w-3.5" />
              <span>
                {trendDirection === 'up' ? '+' : trendDirection === 'down' ? '-' : ''}
                {formatTrendValue(trend.value)}
                {trend.suffix ?? '%'}
              </span>
            </div>
          )}
        </div>

        <div>
          <p className="text-2xl font-bold leading-none tracking-tight text-[#1F2933]">
            {value}
          </p>
          <p className="mt-2 text-sm font-semibold text-[#5E6870]">
            {title}
          </p>
        </div>
      </div>
    </div>
  );

  if (href) {
    return <Link to={href} className="block">{cardContent}</Link>;
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left">
        {cardContent}
      </button>
    );
  }

  return cardContent;
};
