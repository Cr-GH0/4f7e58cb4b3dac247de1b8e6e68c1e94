'use client';
import { useEffect, useRef } from 'react';
import { ADMIN_MARKUP, mountAdmin } from '../../../hermes-volc-standalone/public/admin-view.js';

export default function AdminPage() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => host.current ? mountAdmin(host.current) : undefined, []);
  return <div ref={host} dangerouslySetInnerHTML={{ __html: ADMIN_MARKUP }} />;
}
