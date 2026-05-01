export const QUERY_FOCUS_OFF = {
  refetchOnWindowFocus: false,
} as const;

export const QUERY_SHORT_STALE = {
  ...QUERY_FOCUS_OFF,
  staleTime: 30_000,
} as const;

export const QUERY_ONE_MINUTE_STALE = {
  ...QUERY_FOCUS_OFF,
  staleTime: 60_000,
} as const;

export const QUERY_FIVE_MIN_STALE = {
  ...QUERY_FOCUS_OFF,
  staleTime: 5 * 60 * 1000,
} as const;
