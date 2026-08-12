import { useCallback, useRef } from "react";

export function useSingleFlightGuard(): () => boolean {
  const startedRef = useRef(false);
  return useCallback(() => {
    if (startedRef.current) return false;
    startedRef.current = true;
    return true;
  }, []);
}
