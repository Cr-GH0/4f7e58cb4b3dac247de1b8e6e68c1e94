"use client";
import { useSyncExternalStore } from "react";
import { GROUP_STORAGE_KEY, type Member } from "@/lib/group-session";
import { emptyMembers, type TranscriptLine } from "./group-panel";

type GroupSnapshot = { members: Member[]; lines: TranscriptLine[]; loaded: boolean; saved: string };
const initial: GroupSnapshot = { members: emptyMembers(), lines: [], loaded: false, saved: "正在读取本机记录…" };
let snapshot = initial;
let initialized = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!initialized) {
    initialized = true;
    try {
      const raw = localStorage.getItem(GROUP_STORAGE_KEY);
      const stored = raw ? JSON.parse(raw) : { version: 1, members: emptyMembers(), lines: [] };
      if (stored.version !== 1 || !Array.isArray(stored.members) || stored.members.length !== 3 || !Array.isArray(stored.lines)) throw new Error("Invalid saved group");
      snapshot = { members: stored.members, lines: stored.lines, loaded: true, saved: "记录保存在此浏览器，通话结束和刷新后仍可查看。" };
    } catch {
      snapshot = { ...initial, saved: "本机记录未能读取，请导出已有内容后再更换小组。" };
    }
    emit();
  }
  return () => { listeners.delete(listener); };
}

function update(next: GroupSnapshot) {
  snapshot = next;
  if (next.loaded) {
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify({ version: 1, members: next.members, lines: next.lines }));
      snapshot = { ...next, saved: "记录保存在此浏览器，通话结束和刷新后仍可查看。" };
    } catch { snapshot = { ...next, saved: "本机保存失败，请在关闭页面前导出记录。" }; }
  }
  emit();
}

export const setGroupMembers = (members: Member[]) => update({ ...snapshot, members });
export const setGroupTranscript = (lines: TranscriptLine[]) => update({ ...snapshot, lines });
export const resetGroup = () => update({ ...initial, members: emptyMembers(), loaded: true });
export function useGroupStore() { return useSyncExternalStore(subscribe, () => snapshot, () => initial); }
