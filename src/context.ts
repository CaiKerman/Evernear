import type { ContextPacket, Session, MemoryEntry, Config, Turn } from './types.js';
export function terms(text: string): Set<string> {
    const set = new Set<string>();
    for (const w of text.toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) || []) {
        if (/[\u3400-\u9fff]/.test(w)) {
            if (w.length === 1)
                set.add(w);
            else
                for (let i = 0; i < w.length - 1; i++)
                    set.add(w.slice(i, i + 2));
        }
        else
            set.add(w);
    }
    return set;
}
export function selectMemories(memories: MemoryEntry[], query: string, max = 6) {
    const q = terms(query);
    return memories.map((m, index) => {
        const t = terms(m.text + ' ' + m.tags.join(' '));
        let score = 0;
        for (const x of q)
            if (t.has(x))
                score++;
        if (m.tags.includes('always') || m.text.includes('#always'))
            score += 100;
        return { m, score, index };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, max).map(x => x.m);
}
// Playback receipts and routing metadata stay local. Never imply an unheard answer was heard.
export function historyTurns(turns: Turn[]) { return turns.filter(t => t.text.trim() && (t.role === 'user' || !t.delivery || t.delivery === 'heard')).map(({ role, at, text }) => ({ role, at, text })); }
export function gateContext(session: Session) {
    return { now: new Date().toISOString(), recent: historyTurns(session.turns).filter(t => Date.now() - Date.parse(t.at) < 180000).slice(-2).map(t => ({ ...t, text: t.text.slice(0, 160) })) };
}
export function parseIntervention(raw: string): import('./types.js').Decision {
    let x: any;
    try {
        x = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    }
    catch {
        throw new Error('轻量调度未返回有效JSON，本轮保持沉默');
    }
    const action = x?.action === 'engage' ? 'answer' : x?.action;
    if (!['ignore', 'answer', 'delegate', 'switch_high', 'ambient', 'cancel', 'remember', 'recall', 'capabilities'].includes(action))
        throw new Error('无效的调度去向');
    if (action === 'ignore')
        return { action, utterance: '', reason: '' };
    if (typeof x.utterance !== 'string' || !x.utterance.trim())
        throw new Error('缺少用户原话');
    const v = (key: string, n: number) => typeof x[key] === 'string' ? x[key].slice(0, n) : '';
    return { action, utterance: v('utterance', 4000), reason: v('reason', 120), memory: v('memory', 2000), replaceTaskId: v('replaceTaskId', 100) };
}
export function buildContext(config: Config, instructions: string, memories: MemoryEntry[], session: Session, query: string, purpose: string, runtime?: Record<string, unknown>): ContextPacket {
    const limit = config.contextChars;
    if (instructions.length > Math.floor(limit * 0.4))
        throw new Error('固定指令占用过多上下文，请缩短 instructions.md 或提高上下文上限');
    if (query.length > Math.floor(limit * 0.4))
        throw new Error('本轮输入过长，请拆成几段');
    const packet: ContextPacket = { purpose, query, instructions, memory: [], summary: '', turns: [], tasks: [], runtime: runtime ? structuredClone(runtime) : undefined, text: '', chars: 0, limit };
    // Fixed rules go in the system message once, never inside every historical turn.
    const serialize = () => JSON.stringify({ purpose, now: new Date().toISOString(), query, runtime: packet.runtime,
        ...(packet.memory.length ? { memory: packet.memory } : {}), ...(packet.summary ? { summary: packet.summary } : {}), recent: packet.turns });
    const fits = () => serialize().length + instructions.length <= limit;
    if (!fits() && packet.runtime) {
        const r = packet.runtime;
        delete r.prices;
        delete r.billing;
        delete r.reportedUsage;
    }
    if (!fits())
        throw new Error('当前输入与运行状态超过上下文预算，请缩短问题');
    let turns = historyTurns(session.turns);
    // The current utterance already appears in query; do not send it twice.
    if (turns.at(-1)?.role === 'user' && turns.at(-1)?.text === query)
        turns = turns.slice(0, -1);
    const through = session.turns.findIndex(t => t.id === session.summaryThrough);
    if (session.summary) {
        packet.summary = session.summary.slice(0, 1200);
        if (!fits())
            packet.summary = '';
        if (through >= 0)
            turns = historyTurns(session.turns.slice(through + 1));
    }
    if (turns.at(-1)?.role === 'user' && turns.at(-1)?.text === query)
        turns = turns.slice(0, -1);
    for (const t of turns.slice(-config.recentTurns).reverse()) {
        packet.turns.unshift(t);
        if (!fits()) {
            packet.turns.shift();
            break;
        }
    }
    // Deterministic extractive digest, no background API requests. The full archive stays on disk.
    const older = turns.slice(0, Math.max(0, turns.length - packet.turns.length));
    if (older.length) {
        const base = packet.summary;
        let excerpts = '';
        for (const t of older.slice(-12).reverse()) {
            const line = `${t.role === 'user' ? '用户' : '助手'} ${t.at}: ${t.text.slice(0, 100)}${t.text.length > 100 ? '…' : ''}\n`;
            const next = line + excerpts;
            packet.summary = (base ? base + '\n' : '') + '较早对话摘录（有省略，以新对话为准）：\n' + next;
            if (next.length > 900 || !fits()) {
                packet.summary = excerpts ? (base ? base + '\n' : '') + '较早对话摘录（有省略，以新对话为准）：\n' + excerpts : base;
                break;
            }
            excerpts = next;
        }
    }
    for (const m of selectMemories(memories, query || turns.filter(t => t.role === 'user').slice(-2).map(t => t.text).join(' '))) {
        packet.memory.push(m.text.slice(0, 1800));
        if (!fits())
            packet.memory.pop();
    }
    packet.text = serialize();
    packet.chars = packet.text.length + instructions.length;
    return packet;
}
export const gateRules = `[stage:gate] 你是全天候个人助手的静默调度器。先判断声音是否在对助手说话，再选择去向；不要回答、推理、检索记忆或朗读JSON。每轮只输出一个JSON：
{"action":"ignore|answer|switch_high|delegate|cancel|remember|recall|capabilities|ambient","utterance":"准确的当前原话","reason":"简短理由"}。
广播、电视、同伴聊天、助手播报及回声，发话对象不明时ignore。recent仅帮助识别助手对话的短追问，不能当成新指令。
answer：普通聊天和简单问题；delegate：复杂计算、多步推理和文字分析，优先由文字模型完成一次。switch_high：用户明确选择高级语音模式或需要深入的语音交流，不用于重复处理文字任务。用户选择的语音模式可延续，但task未完成期间统一由轻量语音陪伴交流。后台未完成时闲聊、进度询问仍用answer，不重复委托；明确补充或修订当前问题条件才delegate并附replaceTaskId（必须是task中的编号），仅说继续、好了吗不算修订。不同的新复杂问题不要冒充修订。环境声音不能取消或修改任务。
cancel：用户明确取消助手任务；remember：用户明确要求保存个人记忆，附memory原意；recall：询问个人过去信息；capabilities：询问实际模型启用状态；ambient：明确返回轻量语音。不要扩写原话，不生成答案、算式、过渡语或虚构接口状态。`;
