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

const iconWrapVariants: Record<NonNullable<StatCardProps['color']>, string> = {
  primary: 'bg-primary/7 text-primary ring-1 ring-primary/10',
  accent: 'bg-accent/12 text-accent-foreground ring-1 ring-accent/15',
  teal: 'bg-teal/10 text-teal ring-1 ring-teal/12',
  secondary: 'bg-muted text-foreground ring-1 ring-border',
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
      className="bg-card rounded-xl border border-border p-5 transition-all duration-300 group cursor-pointer hover:-translate-y-0.5"
      style={{ boxShadow: 'var(--shadow-card)' }}
      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = 'var(--shadow-elegant)')}
      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'var(--shadow-card)')}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {title}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-[2rem]">
            {value}
          </p>
        </div>

        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
            iconWrapVariants[color],
          )}
        >
          <Icon className="h-[18px] w-[18px] stroke-[1.85]" />
        </div>
      </div>

      {trend && (
        <div className="mt-5 flex items-center gap-2">
          <div
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold",
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
