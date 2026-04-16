// 3. New Component File: src/components/dashboard/StatCard.tsx
// A reusable, visually appealing card for dashboard stats.
import React from 'react';
import { Link } from 'react-router-dom';
import { cn } from "../../lib/utils";
import clsx from 'clsx';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  color?: 'blue' | 'amber' | 'green' | 'red';
  href?: string;
}

const colorVariants = {
  blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700',
  green: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
};

export const StatCard: React.FC<StatCardProps> = ({ title, value, icon: Icon, trend, color = 'blue', href }) => {
  const cardContent = (
    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-all duration-200 group">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <p className="text-3xl font-bold text-slate-900 mt-2">{value}</p>
          {trend && (
            <div className="flex items-center gap-1 mt-3">
              <span className={clsx("text-xs font-semibold", trend.isPositive ? "text-emerald-600" : "text-rose-600")}>
                {trend.isPositive ? '+' : ''}{trend.value}%
              </span>
              <span className="text-xs text-slate-500">from last month</span>
            </div>
          )}
        </div>
        <div className={cn("p-3 rounded-xl", colorVariants[color])}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </div>
  );

  if (href) {
    return <Link to={href}>{cardContent}</Link>;
  }
  return cardContent;
};