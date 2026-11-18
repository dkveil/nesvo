'use client';

import { useEffect, useState } from 'react';

import { detectSystem, type DetectedSystem } from '@/releases/detect-system';

type HighEntropyValues = {
  platform?: string;
  architecture?: string;
};

type UserAgentData = {
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<HighEntropyValues>;
};

const readUserAgentData = (): UserAgentData | null =>
  'userAgentData' in navigator
    ? ((navigator as Navigator & { userAgentData?: UserAgentData })
        .userAgentData ?? null)
    : null;

const readHighEntropyValues = async (
  data: UserAgentData | null,
): Promise<HighEntropyValues> => {
  if (!data?.getHighEntropyValues) return {};
  try {
    return await data.getHighEntropyValues(['architecture', 'platform']);
  } catch {
    return {};
  }
};

const isSameSystem = (left: DetectedSystem, right: DetectedSystem): boolean =>
  left.os === right.os && left.architecture === right.architecture;

export const useDetectedSystem = (initial: DetectedSystem): DetectedSystem => {
  const [system, setSystem] = useState(initial);

  useEffect(() => {
    let isActive = true;
    const refine = async () => {
      const data = readUserAgentData();
      const values = await readHighEntropyValues(data);
      if (!isActive) return;
      const refined = detectSystem({
        platform: values.platform ?? data?.platform ?? null,
        architecture: values.architecture ?? null,
        isMobile: data?.mobile ?? null,
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
      });
      setSystem(current =>
        isSameSystem(current, refined) ? current : refined,
      );
    };
    void refine();
    return () => {
      isActive = false;
    };
  }, []);

  return system;
};
