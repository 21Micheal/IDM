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
  /** Indigo Vault semantic variants */
  color?: 'primary' | 'accent' | 'teal' | 'secondary';
  href?: string;
}

const colorVariants: Record<NonNullable<StatCardProps['color']>, string> = {
  primary:   'bg-primary text-primary-foreground shadow-sm',
  accent:    'bg-accent text-accent-foreground shadow-sm',
  teal:      'bg-teal text-teal-foreground shadow-sm',
  secondary: 'bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-sm',
};

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  trend,
  color = 'primary',
  href,
}) => {
  const cardContent = (
    <div
      className="bg-card rounded-xl border border-border p-6 transition-all duration-300 group cursor-pointer hover:-translate-y-0.5"
      style={{ boxShadow: 'var(--shadow-card)' }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = 'var(--shadow-elegant)')}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'var(--shadow-card)')}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <p className="text-4xl font-semibold text-foreground tracking-tight mt-3">
            {value}
          </p>
        </div>

        <div className={cn("p-3.5 rounded-xl transition-colors", colorVariants[color])}>
          <Icon className="w-6 h-6" />
        </div>
      </div>

      {trend && (
        <div className="flex items-center gap-2 mt-6">
          <div
            className={cn(
              "flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full",
              trend.isPositive
                ? "bg-teal/15 text-teal"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {trend.isPositive ? (
              <TrendingUp className="w-3.5 h-3.5" />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" />
            )}
            {trend.isPositive ? '+' : ''}{trend.value}%
          </div>
          <span className="text-xs text-muted-foreground">from last month</span>
        </div>
      )}
    </div>
  );

  if (href) {
    return <Link to={href} className="block">{cardContent}</Link>;
  }

  return cardContent;
};
