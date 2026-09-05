"use client";

import { useEffect, useRef, useState } from "react";
import { recordVoiceSample, exportTranscript, speakerLabel, type Member } from "@/lib/group-session";

export const emptyMembers = (): Member[] => [1, 2, 3].map(i => ({ memberId: `speaker_${i}`, name: "", voiceprintId: "" }));
export type TranscriptLine = ReturnType<typeof import("@/lib/group-session").reduceSubtitle>[number];

export function downloadRecord(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "Hermes发言记录.txt"; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function GroupSetup({ members, disabled, onChange, onBusy }: {
  members: Member[]; disabled: boolean; onChange: (m: Member[]) => void; onBusy: (busy: boolean) => void;
}) {
  const [recording, setRecording] = useState(-1);
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function register(index: number) {
    if (recording !== -1 || disabled) return;
    const name = members[index].name.trim();
    if (!name || members.some((m, i) => i !== index && m.name.trim().toLowerCase() === name.toLowerCase())) {
      setStatus("请为每人填写不同的姓名或昵称。"); return;
    }
    const controller = new AbortController(); abortRef.current = controller;
    setRecording(index); onBusy(true); setStatus(`准备录入 ${name} 的声音…`);
    try {
      const sample = await recordVoiceSample({
        deviceId: members.find(m => m.deviceId)?.deviceId,
        onProgress: seconds => setStatus(`${name}：录音 ${seconds}/20 秒，请继续说话。`),
        signal: controller.signal,
      });
      setStatus(`${name}：正在注册声音…`);
      const response = await fetch("/api/voiceprint/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, audio: sample.audio }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      const result = await response.json() as { voiceprintId?: unknown; error?: string };
      const voiceprintId = result.voiceprintId;
      if (!response.ok || typeof voiceprintId !== "string" || !voiceprintId) throw new Error(result.error || "声纹注册失败，请重录。其他人的登记会保留。");
      onChange(members.map((m, i) => i === index ? { ...m, name, voiceprintId, deviceId: sample.deviceId } : m));
      setStatus(`${name}：注册成功。`);
    } catch (error) {
      setStatus(controller.signal.aborted ? "已取消录音。" : `未完成注册：${error instanceof Error ? error.message : "请重试。"}`);
    } finally { setRecording(-1); onBusy(false); abortRef.current = null; }
  }

  return <section className="group-setup" aria-labelledby="group-title">
    <h2 id="group-title">三人共用一台电脑</h2>
    <p>先分别登记声音，再开始英语对话。一次一人说话，发言会按姓名记录。</p>
    <div className="speaker-grid">{members.map((m, i) => <div className="speaker-card" key={m.memberId}>
      <label htmlFor={`name-${i}`}>成员 {i + 1}</label>
      <input id={`name-${i}`} maxLength={32} placeholder="姓名或昵称" value={m.name} disabled={disabled || recording !== -1 || !!m.voiceprintId} onChange={e => onChange(members.map((v, j) => j === i ? { ...v, name: e.target.value } : v))} />
      <span>{m.voiceprintId ? "已登记声音" : "尚未登记声音"}</span>
      <button type="button" disabled={disabled || recording !== -1 || !m.name.trim()} onClick={() => void register(i)}>{m.voiceprintId ? "重新录入" : "录入声音 · 20 秒"}</button>
    </div>)}</div>
    <details><summary>录音说明与朗读材料</summary>
      <p>每人单独录音，其他人保持安静。用自然音量持续说话；至少需要 12 秒有效语音。后续通话会使用同一麦克风。点击录入后，样本会发送至火山引擎注册声纹。</p>
      <blockquote>Hello, I am practising speaking English with my group today. I would like to explain my ideas clearly and listen to other people. We may understand the same event in different ways. I can give reasons for my opinion and ask questions when something is unclear. I look forward to our conversation.</blockquote>
    </details>
    <p role="status">{status || "三人均登记成功后，即可开始通话。"}</p>
    {recording !== -1 && <button type="button" onClick={() => abortRef.current?.abort()}>取消本次录入</button>}
  </section>;
}

export function GroupRecords({ members, lines, onCorrect, onReset, canReset, saved }: {
  members: Member[]; lines: TranscriptLine[]; onCorrect: (key: string, id: string | null) => void;
  onReset: () => void; canReset: boolean; saved: string;
}) {
  const [filter, setFilter] = useState("all");
  const shown = lines.filter(l => filter === "all" || (l.role === "student" && (l.speakerId ?? "unknown") === filter));
  return <section className="group-records" aria-labelledby="records-title">
    <h2 id="records-title">发言记录</h2>
    <p>{saved} 身份不明确或出现抢话时，可将该段标为“待确认”，再分别重述。归属更正用于本机记录；对话中请向 Hermes 重述。</p>
    <div className="record-toolbar">
      <label>查看 <select value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">全部（含 Hermes）</option>
        {members.map((m, i) => <option value={m.memberId} key={m.memberId}>{m.name || `成员 ${i + 1}`}</option>)}
        <option value="unknown">待确认</option>
      </select></label>
      <button type="button" disabled={!shown.length} onClick={() => downloadRecord(exportTranscript(members, lines, filter))}>导出当前记录</button>
      <button type="button" disabled={!canReset} onClick={() => { if (window.confirm("更换小组会清空本机当前登记和记录，请先导出需要保留的内容。火山端已注册的声纹不会被删除。继续？")) { setFilter("all"); onReset(); } }}>更换小组</button>
    </div>
    {shown.length === 0 ? <p>暂无发言记录。</p> : <ol className="record-list">{shown.map(line => <li key={line.key}>
      <div className="record-heading"><strong>{speakerLabel(line, members)}</strong><time>{new Date(line.timestamp).toLocaleTimeString()}</time>{!line.paragraph && <span>未完整收录</span>}{line.corrected && <span>已更正归属</span>}</div>
      <p>{line.text}</p>
      {line.role === "student" && <label>发言归属 <select value={line.speakerId ?? "unknown"} onChange={e => onCorrect(line.key, e.target.value === "unknown" ? null : e.target.value)}>
        <option value="unknown">待确认</option>{members.map(m => <option value={m.memberId} key={m.memberId}>{m.name}</option>)}
      </select></label>}
    </li>)}</ol>}
  </section>;
}
