"use client";
import { useEffect, useRef } from 'react';
import { INITIAL_MARKUP, mountCoach } from '../../hermes-volc-standalone/public/coach-view.js';

export default function Home() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    return mountCoach(host.current, { loadRtc: () => import('@volcengine/rtc') });
  }, []);
  return <div ref={host} dangerouslySetInnerHTML={{ __html: INITIAL_MARKUP }} />;
}
