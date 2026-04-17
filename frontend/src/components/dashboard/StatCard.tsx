import React from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from "../../lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  color?: 'blue' | 'amber' | 'green' | 'purple';
  href?: string;
}

const colorVariants = {
  blue:   'bg-blue-100 text-blue-700',
  amber:  'bg-amber-100 text-amber-700',
  green:  'bg-emerald-100 text-emerald-700',
  purple: 'bg-purple-100 text-purple-700',
};

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  trend,
  color = 'blue',
  href,
}) => {
  const cardContent = (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-lg transition-all duration-300 group cursor-pointer">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-500 tracking-wide">{title}</p>
          <p className="text-4xl font-semibold text-slate-900 tracking-tighter mt-3">
            {value}
          </p>
        </div>

        <div className={cn("p-4 rounded-2xl transition-colors", colorVariants[color])}>
          <Icon className="w-7 h-7" />
        </div>
      </div>

      {/* Trend Indicator */}
      {trend && (
        <div className="flex items-center gap-2 mt-6">
          <div className={cn(
            "flex items-center gap-1 text-xs font-semibold px-3 py-1 rounded-full",
            trend.isPositive 
              ? "bg-emerald-100 text-emerald-700" 
              : "bg-rose-100 text-rose-700"
          )}>
            {trend.isPositive ? (
              <TrendingUp className="w-3.5 h-3.5" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" />
            )}
            {trend.isPositive ? '+' : ''}{trend.value}%
          </div>
          <span className="text-xs text-slate-500">from last month</span>
        </div>
      )}
    </div>
  );

  if (href) {
    return <Link to={href} className="block">{cardContent}</Link>;
  }

  return cardContent;
};