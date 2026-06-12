/**
 * components/documents/StarButton.tsx
 *
 * Drop-in favourite toggle.
 * Usage:
 *   <StarButton documentId={doc.id} />
 *
 * Works in both list rows and the detail header.
 * Uses optimistic updates — the star flips instantly with a rollback on error.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import clsx from "clsx";
import { favouritesAPI } from "@/services/foldersApi";
import type { FavouriteCheckResult } from "../../types";

interface StarButtonProps {
  documentId: string;
  /** Size variant */
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
  variant?: "default" | "command";
}

export function StarButton({
  documentId,
  size = "md",
  showLabel = false,
  className,
  variant = "default",
}: StarButtonProps) {
  const qc        = useQueryClient();
  const cacheKey  = ["favourite-check", documentId];

  // Check starred status
  const { data } = useQuery<FavouriteCheckResult>({
    queryKey: cacheKey,
    queryFn: () => favouritesAPI.check(documentId).then((r) => r.data),
    staleTime: 30_000,
  });

  const starred = data?.starred ?? false;

  // Toggle with optimistic update
  const toggle = useMutation({
    mutationFn: () => favouritesAPI.toggle(documentId),

    onMutate: async () => {
      await qc.cancelQueries({ queryKey: cacheKey });
      const previous = qc.getQueryData<FavouriteCheckResult>(cacheKey);
      qc.setQueryData<FavouriteCheckResult>(cacheKey, (old) => ({
        starred: !old?.starred,
        favourite_id: old?.favourite_id ?? null,
      }));
      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(cacheKey, context.previous);
      }
    },

    onSuccess: (res) => {
      // Update favourites list cache
      qc.invalidateQueries({ queryKey: ["favourites"] });
      qc.invalidateQueries({ queryKey: ["folder-documents"] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
      // Update check cache with server truth
      qc.setQueryData<FavouriteCheckResult>(cacheKey, {
        starred: res.data.starred,
        favourite_id: res.data.id ?? data?.favourite_id ?? null,
      });
    },
  });

  const iconSize = size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4";
  const btnSize  = size === "sm" ? "p-1" : "p-1.5";
  const label = starred ? "Remove favourite" : "Add to favourites";
  const isCommandVariant = variant === "command";

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate();
      }}
      disabled={toggle.isPending}
      className={clsx(
        isCommandVariant
          ? "inline-flex items-center gap-1"
          : showLabel
            ? "inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium"
            : btnSize,
        "transition-all",
        !isCommandVariant && (
          starred
            ? "text-amber-400 hover:text-amber-500"
            : "text-muted-foreground hover:text-amber-400"
        ),
        !isCommandVariant && (
          showLabel
            ? "hover:border-amber-200 hover:bg-amber-50 dark:hover:bg-amber-900/20"
            : "rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20"
        ),
        className,
      )}
    >
      <Star
        className={clsx(
          iconSize,
          "transition-all",
          starred && "fill-current",
          toggle.isPending && "opacity-50",
        )}
      />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
