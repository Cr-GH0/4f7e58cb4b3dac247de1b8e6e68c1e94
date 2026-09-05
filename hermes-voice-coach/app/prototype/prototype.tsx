"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

type View = "home" | "prepare" | "talk" | "summary";
type Recording = "idle" | "recording" | "checking" | "done" | "error";
type Person = { name: string; ready: boolean };
type Message = { id: number; speaker: number | null | "hermes"; text: string; part?: number; draft?: string; confirmed?: boolean };
type Turn = { speaker: number | null; text: string; part: number; reply: string };
const PARTS = [
  { title: "发生了什么", en: "The event", prompt: "What happened?" },
  { title: "交流与变化", en: "Exchange & change", prompt: "What was exchanged, and what changed?" },
  { title: "原则与理由", en: "A principle & why", prompt: "Which principle matters here, and why?" },
  { title: "态度与行动", en: "Attitude & action", prompt: "What can young people do?" },
];
const PEOPLE = ["林然", "陈曦", "周宁"];
const FIRST: Message = { id: 1, speaker: "hermes", text: "Let’s start with an event that interests you. What would you like to talk about?" };
const TURNS: Turn[] = [
  { speaker: 0, part: 0, text: "I’d like to talk about the Silk Road. People from different places met and traded with each other.", reply: "You’re interested in how people connected through the Silk Road. What did they exchange besides goods?" },
  { speaker: 0, part: 1, text: "They also exchanged ideas and skills. People could learn different ways of making things.", reply: "You’ve connected exchange with learning new skills. Which principle do you see in that?" },
  { speaker: 1, part: 0, text: "I’m also interested in the Silk Road, but I want to focus on the people who travelled along it.", reply: "Your focus is the travellers themselves. What would you like to say about their experiences?" },
  { speaker: null, part: 0, text: "I want to talk about how people with different traditions learned to communicate.", reply: "I heard your idea, but I’m not sure who was speaking. Who would like this idea added to their outline?" },
  { speaker: 0, part: 2, text: "Different cultures can learn from each other. We can learn something new without giving up our own traditions.", reply: "You see learning from others and keeping your own traditions as compatible. What could young people do with that idea?" },
  { speaker: 0, part: 3, text: "We can listen before we judge, and ask people about the meaning of their traditions.", reply: "Your four ideas are now in your draft. Take a look: is there anything you would like to change before you try your talk?" },
];
const READING = "Hello, I am practising speaking English with my group today. I would like to explain my ideas clearly and listen to other people. We may understand the same event in different ways. I can give reasons for my opinion and ask questions when something is unclear. I look forward to our conversation.";

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    back: <><path d="M19 12H5m6-6-6 6 6 6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
    muted: <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2M9 5V4a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    note: <><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M8 9h5M8 14h8" /><path d="m15 3 3 3 3-3m-3 3V1" /></>,
    chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />,
    people: <><circle cx="9" cy="8" r="3" /><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 5a3 3 0 0 1 0 6m3 4a6 6 0 0 1 3 5" /></>,
    edit: <><path d="m14 5 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
    send: <><path d="M12 20V4m-6 6 6-6 6 6" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    dots: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.chat}</svg>;
}

function Avatar({ name, index, small = false }: { name: string; index: number; small?: boolean }) {
  return <span className={`hp-avatar hp-person-${index} ${small ? "hp-avatar-small" : ""}`} aria-hidden="true">{name.trim().slice(0, 1) || index + 1}</span>;
}

function outlineFor(messages: Message[], person: number) {
  return PARTS.map((_, part) => messages.filter(m => m.speaker === person && m.part === part).at(-1));
}

function OutlineContent({ people, selected, messages, onSelect, onConfirm, onEdit, onPractice }: {
  people: Person[]; selected: number; messages: Message[]; onSelect: (i: number) => void;
  onConfirm: (id: number) => void; onEdit: (id: number, text: string) => void; onPractice?: (part: number) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (editing !== null) editRef.current?.focus(); }, [editing]);
  const items = outlineFor(messages, selected);
  const confirmed = items.filter(m => m?.confirmed).length;
  const collected = items.filter(Boolean).length;
  return <>
    <div className="hp-person-tabs" aria-label="查看个人提纲">{people.map((p, i) => <button key={i} type="button" className={selected === i ? "is-selected" : ""} aria-pressed={selected === i} onClick={() => { setEditing(null); onSelect(i); }}><Avatar name={p.name} index={i} small />{p.name}</button>)}</div>
    <div className="hp-outline-progress"><span>{collected} / 4 已整理</span><span>{confirmed} 项已确认</span></div>
    <div className="hp-progress-segments" aria-hidden="true">{items.map((item, i) => <i key={i} className={item?.confirmed ? "is-confirmed" : item ? "is-collected" : ""} />)}</div>
    <ol className="hp-outline-list">{PARTS.map((part, i) => {
      const item = items[i];
      return <li key={part.en}>
        <div className="hp-outline-label"><span className={`hp-part-number ${item?.confirmed ? "is-confirmed" : ""}`}>{item?.confirmed ? <Icon name="check" size={13} /> : String(i + 1).padStart(2, "0")}</span><h3>{part.title}</h3>{item && <span className="hp-draft-label">{item.confirmed ? "已确认" : "草稿"}</span>}</div>
        {item ? editing === item.id ? <form className="hp-inline-edit" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onEdit(item.id, draft.trim()); setEditing(null); } }}><label className="hp-sr-only" htmlFor={`outline-edit-${item.id}`}>修改{part.title}</label><textarea id={`outline-edit-${item.id}`} ref={editRef} value={draft} onChange={e => setDraft(e.target.value)} rows={5} /><div><button type="button" className="hp-text-button" onClick={() => setEditing(null)}>取消</button><button className="hp-button hp-small" disabled={!draft.trim()}>保存修改</button></div></form> : <>
          <p lang="en" className="hp-outline-text">{item.draft || item.text}</p>
          <div className="hp-outline-actions"><button type="button" onClick={() => { setEditing(item.id); setDraft(item.draft || item.text); }}><Icon name="edit" size={14} />修改</button>{!item.confirmed && <button type="button" onClick={() => onConfirm(item.id)}><Icon name="check" size={15} />意思准确</button>}</div>
        </> : <div className="hp-outline-empty"><p>还没有整理这一点。</p>{onPractice && <button type="button" onClick={() => onPractice(i)}>聊聊这一点<Icon name="arrow" size={14} /></button>}</div>}
      </li>;
    })}</ol>
    <p className="hp-outline-footnote">这里保留自己的意思，可以随时修改。</p>
  </>;
}

export default function HermesPrototype() {
  const [view, setView] = useState<View>("home");
  const [people, setPeople] = useState<Person[]>(PEOPLE.map(name => ({ name, ready: false })));
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState(0);
  const [enrolling, setEnrolling] = useState(0);
  const [recording, setRecording] = useState<Recording>("idle");
  const [recordProgress, setRecordProgress] = useState(0);
  const [recordError, setRecordError] = useState("");
  const [messages, setMessages] = useState<Message[]>([FIRST]);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [responding, setResponding] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [navigationToggled, setNavigationToggled] = useState(false);
  const [input, setInput] = useState("");
  const [author, setAuthor] = useState(0);
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [editingMessage, setEditingMessage] = useState<number | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [previewMenu, setPreviewMenu] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const responseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageEnd = useRef<HTMLDivElement | null>(null);
  const messageEditRef = useRef<HTMLTextAreaElement | null>(null);
  const nextId = useRef(2);
  const readyCount = people.filter(p => p.ready).length;
  const hasConversation = messages.length > 1;
  const isRecording = recording === "recording" || recording === "checking";

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); if (responseTimer.current) clearTimeout(responseTimer.current); }, []);
  useEffect(() => { if (view === "talk") messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, view]);
  useEffect(() => { if (!announcement) return; const t = setTimeout(() => setAnnouncement(""), 4000); return () => clearTimeout(t); }, [announcement]);
  useEffect(() => { if (editingMessage !== null) messageEditRef.current?.focus(); }, [editingMessage]);

  function navigate(next: View) { if (isRecording && next !== "prepare") cancelRecording(); setView(next); setNavigationToggled(false); setPreviewMenu(false); }
  function cancelRecording() { if (timer.current) clearInterval(timer.current); timer.current = null; setRecording("idle"); setRecordProgress(0); }
  function beginRecording() {
    const name = people[enrolling].name.trim();
    if (!name || people.some((p, i) => i !== enrolling && p.name.trim() === name)) { setRecordError("请填写一个与其他成员不同的姓名或昵称。"); return; }
    setRecordError(""); setRecording("recording"); setRecordProgress(0);
    let elapsed = 0;
    timer.current = setInterval(() => {
      elapsed += 1; setRecordProgress(Math.min(elapsed / 15 * 100, 100));
      if (elapsed === 15) setRecording("checking");
      if (elapsed >= 19) {
        if (timer.current) clearInterval(timer.current); timer.current = null;
        setPeople(old => old.map((p, i) => i === enrolling ? { name: p.name.trim(), ready: true } : p)); setRecording("done");
      }
    }, 180);
  }
  function enterConversation() { setPaused(false); navigate("talk"); }
  function seedConversation(turnCount = 2, destination: View = "talk") {
    cancelRecording(); if (responseTimer.current) clearTimeout(responseTimer.current); setResponding(false);
    setPeople(old => old.map((p, i) => ({ name: p.name.trim() || PEOPLE[i], ready: true })));
    const initial: Message[] = [FIRST];
    for (const turn of TURNS.slice(0, turnCount)) {
      initial.push({ id: nextId.current++, speaker: turn.speaker, text: turn.text, part: turn.part, confirmed: false });
      initial.push({ id: nextId.current++, speaker: "hermes", text: turn.reply });
    }
    setMessages(initial); setStep(turnCount); setPaused(false); setSelected(0); setOutlineOpen(true); navigate(destination);
  }
  function appendTurn(turn: Turn) {
    setMessages(old => [...old, { id: nextId.current++, speaker: turn.speaker, text: turn.text, part: turn.part }]);
    if (turn.speaker !== null) setSelected(turn.speaker);
    setResponding(true); setOutlineOpen(true);
    responseTimer.current = setTimeout(() => { setMessages(old => [...old, { id: nextId.current++, speaker: "hermes", text: turn.reply }]); setResponding(false); }, 900);
  }
  function nextExample() { if (step >= TURNS.length || responding || paused) return; appendTurn(TURNS[step]); setStep(step + 1); }
  function sendText() {
    if (!input.trim() || responding) return;
    setMessages(old => [...old, { id: nextId.current++, speaker: author, text: input.trim() }, { id: nextId.current++, speaker: "hermes", text: "I’ve kept your words here. Which part of your outline would you like to explore?" }]);
    setInput(""); setSelected(author); setAnnouncement("文字已加入示例对话；原型不会生成真实 AI 回答。");
  }
  function confirm(id: number) { setMessages(old => old.map(m => m.id === id ? { ...m, confirmed: true } : m)); }
  function editOutline(id: number, text: string) { setMessages(old => old.map(m => m.id === id ? { ...m, draft: text, confirmed: false } : m)); setAnnouncement("提纲已修改，可以重新确认意思。"); }
  function correctPerson(id: number, speaker: number | null) {
    setMessages(old => old.map(m => m.id === id ? { ...m, speaker, confirmed: false } : m)); setCorrecting(null);
    if (speaker !== null) { setSelected(speaker); setOutlineOpen(true); }
    setAnnouncement(speaker === null ? "这段发言暂不计入个人提纲。" : `这段发言和对应提纲已归到${people[speaker].name}。`);
  }
  function askPart(part: number) { setMessages(old => [...old, { id: nextId.current++, speaker: "hermes", text: `${people[selected].name}, ${PARTS[part].prompt}` }]); navigate("talk"); setPaused(false); }
  function downloadOutline() {
    const items = outlineFor(messages, selected);
    const text = [`# ${people[selected].name} · 文明交流发言提纲`, "", "Hermes 交互原型 · 示例内容", "", ...PARTS.flatMap((part, i) => [`## ${i + 1}. ${part.title}`, items[i]?.draft || items[i]?.text || "尚未整理", `状态：${items[i]?.confirmed ? "已确认" : items[i] ? "待确认" : "未开始"}`, ""])].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `Hermes_${people[selected].name}_提纲示例.txt`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setAnnouncement("个人提纲示例已导出。");
  }
  const outlineProps = { people, selected, messages, onSelect: setSelected, onConfirm: confirm, onEdit: editOutline, onPractice: askPart };

  return <div className={`hp-app ${navigationToggled ? "hp-navigation-toggled" : ""}`} lang="zh-Hans">
    <aside className="hp-sidebar" aria-label="练习导航">
      <a className="hp-wordmark" href="/prototype" onClick={e => { e.preventDefault(); navigate("home"); }}>Hermes<span>英语语音教练</span></a>
      <nav className="hp-navigation"><button type="button" className={view === "home" || view === "prepare" ? "is-active" : ""} onClick={() => navigate("home")}><Icon name="chat" />练习首页</button>{hasConversation && <button type="button" className={view === "talk" ? "is-active" : ""} onClick={() => navigate("talk")}><Icon name="play" />继续交流</button>}<button type="button" className={view === "summary" ? "is-active" : ""} onClick={() => navigate("summary")} disabled={!hasConversation}><Icon name="note" />个人提纲</button></nav>
      <div className="hp-sidebar-group"><p className="hp-section-label">本次小组<span>3 人</span></p>{people.map((p, i) => <button type="button" key={i} className="hp-roster-person" onClick={() => { setSelected(i); if (hasConversation) { navigate("talk"); setOutlineOpen(true); } else { setEnrolling(i); setRecording(p.ready ? "done" : "idle"); navigate("prepare"); } }} disabled={isRecording}><Avatar name={p.name} index={i} /><span>{p.name || `成员 ${i + 1}`}<small>{p.ready ? "已准备" : "待准备"}</small></span>{p.ready && <Icon name="check" size={16} />}</button>)}</div>
      <div className="hp-sidebar-bottom"><Icon name="people" size={18} /><span>一台电脑，一起交流。<br />每个人保留自己的提纲。</span></div>
    </aside>
    <button type="button" className="hp-nav-scrim" aria-label="关闭导航" onClick={() => setNavigationToggled(false)} />
    <div className="hp-workspace">
      <header className="hp-header"><div className="hp-header-left"><button type="button" className="hp-icon-button" aria-label="切换导航" onClick={() => setNavigationToggled(!navigationToggled)}><Icon name="panel" /></button><span>{view === "home" ? "英语口语练习" : view === "prepare" ? "小组准备" : view === "summary" ? "个人提纲" : "文明交流"}</span></div><div className="hp-preview"><span>交互原型 · 模拟语音与对话</span><button type="button" className="hp-icon-button" aria-label="预览场景" aria-expanded={previewMenu} onClick={() => setPreviewMenu(!previewMenu)}><Icon name="dots" /></button>{previewMenu && <div className="hp-preview-menu"><p>查看关键状态</p><button type="button" onClick={() => { cancelRecording(); navigate("home"); }}>进入练习</button><button type="button" onClick={() => { cancelRecording(); setEnrolling(people.findIndex(p => !p.ready) < 0 ? 0 : people.findIndex(p => !p.ready)); navigate("prepare"); }}>三人准备</button><button type="button" onClick={() => seedConversation(2)}>语音交流</button><button type="button" onClick={() => seedConversation(4)}>发言归属待确认</button><button type="button" onClick={() => { cancelRecording(); setPeople(old => old.map((p, i) => i === enrolling ? { ...p, ready: false } : p)); setRecordError("没有听到清楚的声音。请检查麦克风，再试一次。其他成员的登记会保留。"); setRecording("error"); navigate("prepare"); }}>录音失败</button><button type="button" onClick={() => seedConversation(6, "summary")}>个人提纲</button></div>}</div></header>

      {view === "home" && <main className="hp-home"><div className="hp-home-content"><p className="hp-eyebrow">文明交流 · 三人练习</p><h1>{hasConversation ? "继续把想法说清楚。" : "从一个文明交流事件聊起。"}</h1><p className="hp-home-description">一起交流，每个人形成自己的英语发言提纲。</p><form className="hp-start-composer" onSubmit={e => { e.preventDefault(); if (hasConversation || readyCount === 3) enterConversation(); else navigate("prepare"); }}><label className="hp-sr-only" htmlFor="practice-topic">想讨论的事件</label><textarea id="practice-topic" placeholder="写下想讨论的事件，或开始后再聊……" rows={2} maxLength={240} value={topic} onChange={e => setTopic(e.target.value)} /><div><span className="hp-device-note"><Icon name="people" size={18} />3 人 · 1 台设备</span><button className="hp-button"><Icon name="mic" size={17} />{hasConversation ? "继续交流" : "开始练习"}</button></div></form><div className="hp-outline-path" aria-label="四点提纲">{PARTS.map((part, i) => <span key={part.title}><b>{String(i + 1).padStart(2, "0")}</b>{part.title}</span>)}</div>{hasConversation ? <button className="hp-home-secondary" type="button" onClick={() => navigate("summary")}>查看本次提纲<Icon name="arrow" size={16} /></button> : <button className="hp-home-secondary" type="button" onClick={() => seedConversation(2)}>先看看交流的样子<Icon name="arrow" size={16} /></button>}</div><p className="hp-home-bottom">从自己的理解出发，随时补充或修改。</p></main>}

      {view === "prepare" && <main className="hp-prepare"><div className="hp-prepare-inner"><div className="hp-stage-top"><button type="button" className="hp-text-button" disabled={isRecording} onClick={() => navigate("home")}><Icon name="back" size={17} />返回</button><span>声音登记 · {readyCount} / 3 已准备</span></div><h1>{readyCount === 3 && recording === "done" ? "三个人都准备好了。" : "先让 Hermes 认识你们的声音。"}</h1><p className="hp-prepare-description">使用同一个麦克风，依次说一小段英语。</p><ol className="hp-preparation-steps">{people.map((p, i) => <li key={i}><button type="button" disabled={isRecording} className={i === enrolling ? "is-current" : ""} aria-current={i === enrolling ? "step" : undefined} onClick={() => { setEnrolling(i); setRecording(p.ready ? "done" : "idle"); setRecordError(""); }}><span className={p.ready ? "hp-step-circle is-ready" : "hp-step-circle"}>{p.ready ? <Icon name="check" size={17} /> : i + 1}</span><span>{p.name || `成员 ${i + 1}`}</span></button></li>)}</ol>
        <section className="hp-enrollment" aria-label="当前成员声音登记"><div className="hp-name-row"><Avatar name={people[enrolling].name} index={enrolling} /><label htmlFor="member-name">姓名或昵称<input id="member-name" value={people[enrolling].name} maxLength={20} disabled={isRecording} onChange={e => { const name = e.target.value; setPeople(old => old.map((p, i) => i === enrolling ? { ...p, name } : p)); setRecordError(""); }} /></label></div>
          {recording === "done" && people[enrolling].ready ? <div className="hp-ready-state"><span className="hp-ready-icon"><Icon name="check" size={30} /></span><h2>{people[enrolling].name}，准备好了。</h2><p>{readyCount === 3 ? "开始交流后，发言会分别整理到每个人的提纲中。" : "这一位已完成，接下来换下一位。"}</p><button type="button" className="hp-text-button" onClick={() => { setRecording("idle"); setRecordError(""); }}>重新录入声音</button></div> : <><div className="hp-reading"><span>可以读下面这段，也可以介绍自己。</span><p lang="en">{READING}</p></div><div className={`hp-recording-status ${isRecording ? "is-recording" : ""}`} role="status"><div className="hp-recording-symbol">{isRecording ? <span className="hp-level-bars" aria-hidden="true">{[7, 16, 23, 12, 28, 19, 9].map((h, i) => <i key={i} style={{ height: h, animationDelay: `${i * 0.12}s` }} />)}</span> : <Icon name="mic" size={21} />}</div><div><strong>{recording === "checking" ? "正在确认声音…" : recording === "recording" ? "正在录入声音…" : "用自然音量说话"}</strong><span>{isRecording ? "原型正在快速演示录音状态，不采集声音。" : "每人约 20 秒，其他成员暂时保持安静。"}</span></div></div>{isRecording && <div className="hp-record-progress" role="progressbar" aria-label="录音演示进度" aria-valuenow={Math.round(recordProgress)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${recordProgress}%` }} /></div>}{recordError && <p className="hp-error" role="alert">{recordError}</p>}</>}
          <div className="hp-prepare-actions">{recording === "done" && people[enrolling].ready ? <><span><Icon name="check" size={16} />这一位已准备</span><button type="button" className="hp-button" onClick={() => { if (readyCount === 3) { enterConversation(); } else { setEnrolling(people.findIndex(p => !p.ready)); setRecording("idle"); setRecordError(""); } }}>{readyCount === 3 ? "开始交流" : `下一位 · ${people[people.findIndex(p => !p.ready)]?.name}`}<Icon name="arrow" size={17} /></button></> : isRecording ? <><span>正在演示声音登记</span><button type="button" className="hp-button hp-secondary" onClick={cancelRecording}>取消本次录入</button></> : <><span>{enrolling + 1} / 3 位成员</span><button type="button" className="hp-button" disabled={!people[enrolling].name.trim()} onClick={beginRecording}><Icon name="mic" size={17} />{recording === "error" ? "重新录音" : "开始录音"}</button></>}</div>
        </section></div></main>}

      {view === "talk" && <main className={`hp-talk ${outlineOpen ? "hp-outline-is-open" : ""}`}><section className="hp-conversation" aria-label="小组对话"><div className="hp-conversation-top"><div><h1>{topic.trim() || (step > 0 ? "丝绸之路上的交流" : "文明交流")}</h1><span>{people.map(p => p.name).join("、")} · 各自表达，共同交流</span></div><button type="button" className={`hp-button hp-secondary hp-small ${outlineOpen ? "is-selected" : ""}`} onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}><Icon name="note" size={17} />提纲</button></div><div className="hp-messages"><div className="hp-conversation-beginning">本次交流</div>{messages.map(message => <article className={`hp-message ${message.speaker === "hermes" ? "hp-coach-message" : "hp-student-message"} ${message.speaker === null ? "hp-unknown-message" : ""}`} key={message.id}><div className="hp-message-heading">{message.speaker === "hermes" ? <span className="hp-coach-wordmark">Hermes</span> : message.speaker === null ? <span className="hp-unknown-label">发言者待确认</span> : <><Avatar name={people[message.speaker].name} index={message.speaker} small /><strong>{people[message.speaker].name}</strong></>}{typeof message.speaker === "number" && <button type="button" className="hp-message-edit" aria-label={`更正${people[message.speaker].name}的发言归属`} onClick={() => setCorrecting(correcting === message.id ? null : message.id)}>更正归属</button>}</div>{editingMessage === message.id ? <form className="hp-inline-edit" onSubmit={e => { e.preventDefault(); if (!messageDraft.trim()) return; setMessages(old => old.map(m => m.id === message.id ? { ...m, text: messageDraft.trim(), draft: undefined, confirmed: false } : m)); setEditingMessage(null); }}><label className="hp-sr-only" htmlFor={`message-${message.id}`}>修改发言文字</label><textarea id={`message-${message.id}`} value={messageDraft} onChange={e => setMessageDraft(e.target.value)} rows={3} ref={messageEditRef} /><div><button type="button" className="hp-text-button" onClick={() => setEditingMessage(null)}>取消</button><button className="hp-button hp-small" disabled={!messageDraft.trim()}>保存修改</button></div></form> : <p lang="en">{message.text}</p>}{message.speaker === null && <div className="hp-identity-question"><span>这段话是谁说的？</span>{people.map((p, i) => <button type="button" key={i} onClick={() => correctPerson(message.id, i)}>{p.name}</button>)}</div>}{correcting === message.id && <div className="hp-correction"><span>将这段话归给</span>{people.map((p, i) => <button key={i} type="button" onClick={() => correctPerson(message.id, i)}>{p.name}</button>)}<button type="button" onClick={() => correctPerson(message.id, null)}>待确认</button><button type="button" aria-label="取消更正归属" className="hp-icon-button" onClick={() => setCorrecting(null)}><Icon name="close" size={14} /></button></div>}{message.speaker !== "hermes" && editingMessage !== message.id && <div className="hp-message-bottom"><button type="button" onClick={() => { setEditingMessage(message.id); setMessageDraft(message.text); }}><Icon name="edit" size={13} />修改文字</button>{message.part !== undefined && message.speaker !== null && <button type="button" onClick={() => { setSelected(message.speaker as number); setOutlineOpen(true); }}>已整理到「{PARTS[message.part].title}」<Icon name="arrow" size={13} /></button>}</div>}</article>)}{responding && <p className="hp-thinking" role="status">Hermes 正在回应<span>…</span></p>}<div ref={messageEnd} /></div><div className="hp-composer-area"><div className="hp-voice-toolbar"><div className="hp-voice-state"><span className={`hp-status-dot ${paused ? "is-paused" : ""}`} /><span>{paused ? "交流已暂停" : responding ? "Hermes 正在回应" : "可以接着说"}</span></div><div><button type="button" onClick={() => setPaused(!paused)}><Icon name={paused ? "mic" : "muted"} size={18} />{paused ? "继续交流" : "暂停麦克风"}</button><button type="button" onClick={() => { setPaused(true); navigate("summary"); }}>结束本次交流</button></div></div><form className="hp-text-composer" onSubmit={e => { e.preventDefault(); sendText(); }}><label className="hp-sr-only" htmlFor="message-input">文字发言</label><textarea id="message-input" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendText(); } }} placeholder="也可以把想说的话写下来…" rows={2} maxLength={2000} /><div className="hp-composer-bottom"><label>文字署名<select aria-label="文字发言者" value={author} onChange={e => setAuthor(Number(e.target.value))}>{people.map((p, i) => <option key={i} value={i}>{p.name}</option>)}</select></label><button type="submit" className="hp-send" disabled={!input.trim() || responding} aria-label="发送文字"><Icon name="send" size={18} /></button></div></form><div className="hp-example-control"><span>示例对话</span><button type="button" onClick={nextExample} disabled={step >= TURNS.length || responding || paused}>{step >= TURNS.length ? "示例已结束，可查看个人提纲" : "演示下一段发言"}{step < TURNS.length && <Icon name="arrow" size={14} />}</button></div></div></section>{outlineOpen && <aside className="hp-outline-pane" aria-label="个人提纲"><div className="hp-outline-pane-top"><div><h2>个人提纲</h2><span>跟随交流，逐步整理</span></div><button type="button" className="hp-icon-button" aria-label="关闭个人提纲" onClick={() => setOutlineOpen(false)}><Icon name="close" size={18} /></button></div><div className="hp-outline-scroll"><OutlineContent {...outlineProps} /></div><button type="button" className="hp-outline-expand" onClick={() => navigate("summary")}>完整查看与导出<Icon name="arrow" size={16} /></button></aside>}</main>}

      {view === "summary" && <main className="hp-summary"><div className="hp-summary-inner"><button type="button" className="hp-text-button" onClick={enterConversation}><Icon name="back" size={17} />返回交流</button><div className="hp-summary-heading"><p className="hp-eyebrow">本次练习</p><h1>文明交流发言提纲</h1><p>确认意思，再用提纲练习两分钟的英语表达。</p></div><section className="hp-summary-paper" aria-label="本次个人提纲"><OutlineContent {...outlineProps} /></section><div className="hp-summary-actions"><button type="button" className="hp-button hp-secondary" disabled={!outlineFor(messages, selected).some(Boolean)} onClick={downloadOutline}><Icon name="download" size={17} />导出{people[selected].name}的提纲</button><button type="button" className="hp-button" onClick={enterConversation}>继续交流<Icon name="arrow" size={17} /></button></div></div></main>}
    </div><div className={`hp-toast ${announcement ? "is-visible" : ""}`} role="status">{announcement}</div>
  </div>;
}
