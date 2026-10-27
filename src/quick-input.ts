import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Config } from './types.js';
import { TextModel, safeError } from './providers.js';
import { quickPresets } from './quick-settings.js';
import type { RequestController } from './requests.js';
import type { TextWork } from './text-work.js';

type Message = { role: 'user' | 'assistant'; content: string };
export class QuickInput extends EventEmitter {
    private history: Message[] = [];
    private audio = { status: 'idle', message: '' };
    private draft = { id: '', text: '' };
    setAudio(status: string, message: string) { this.audio = { status, message }; this.publish(); }
    setDraft(id: string, text: string) { this.draft = { id, text }; this.publish(); }
    private epoch = 0;
    private active?: { id: string; abort: AbortController };
    private view = { id: '', status: 'idle', result: '', error: '', firstMs: null as number | null, totalMs: null as number | null };
    constructor(private store: Store, private work: TextWork, private requests: RequestController, private usage: (record: any) => void) { super(); work.on('change', () => this.publish()); }
    snapshot() { return { ...this.view, audio: this.audio, draft: this.draft, settings: this.store.config.quickInput, busySource: this.work.source || '', historyTurns: this.history.length }; }
    private publish() { this.emit('change', this.snapshot()); }
    clear() { this.epoch++; this.history = []; this.publish(); }
    settingsChanged(before: Config) {
        const a = before.quickInput, b = this.store.config.quickInput;
        if (a.context !== b.context || a.preset !== b.preset || JSON.stringify(a.parameters) !== JSON.stringify(b.parameters) || JSON.stringify(before.advanced) !== JSON.stringify(this.store.config.advanced)) this.clear();
        else this.publish();
    }
    cancel() {
        if (!this.active) return;
        if (!this.active.abort.signal.aborted) this.active.abort.abort(new Error('已取消'));
        this.view.status = 'cancelled'; this.view.error = '已取消；不完整结果不会用于后续上下文。'; this.publish();
    }
    async send(input: unknown) {
        if (typeof input !== 'string' || !input.trim()) throw new Error('请输入文字');
        if (this.active && !this.active.abort.signal.aborted) throw new Error('快捷生成正在运行，请先取消');
        const config = structuredClone(this.store.config), settings = config.quickInput;
        const prompt = quickPresets[settings.preset].prompt;
        if (prompt.length + input.length > config.contextChars) throw new Error('本次输入超过上下文字符上限，请缩短输入');
        const turns = settings.context ? this.history.map(m => ({ ...m })) : [];
        while (turns.length && (turns.length > config.recentTurns || turns.reduce((n, t) => n + t.content.length, prompt.length + input.length) > config.contextChars)) turns.splice(0, 2);
        const job = { id: randomUUID(), abort: new AbortController() };
        const release = this.work.claim('快捷输入', job.abort);
        const epoch = this.epoch, started = performance.now();
        this.active = job;
        this.view = { id: job.id, status: 'running', result: '', error: '', firstMs: null, totalMs: null }; this.publish();
        const timer = setTimeout(() => job.abort.abort(new Error('快捷生成超时')), config.taskTimeoutSeconds * 1000);
        try {
            const model = new TextModel(config, this.usage, { requests: this.requests, source: 'quick-input', taskId: job.id, manual: true });
            const result = await model.complete([{ role: 'system', content: prompt }, ...turns, { role: 'user', content: input }], job.abort.signal, {
                parameters: settings.parameters[settings.preset],
                onDelta: text => {
                    if (this.active !== job || job.abort.signal.aborted) return;
                    this.view.firstMs ??= Math.round(performance.now() - started);
                    this.view.result += text; this.publish();
                }
            });
            job.abort.signal.throwIfAborted();
            if (this.active !== job) return;
            this.view.result = result; this.view.status = 'done';
            this.view.firstMs ??= Math.round(performance.now() - started);
            if (settings.context && epoch === this.epoch) {
                turns.push({ role: 'user', content: input }, { role: 'assistant', content: result });
                while (turns.length && (turns.length > config.recentTurns || turns.reduce((n, t) => n + t.content.length, prompt.length) > config.contextChars)) turns.splice(0, 2);
                this.history = turns;
            }
        } catch (e) {
            if (this.active === job) {
                this.view.status = this.view.status === 'cancelled' ? 'cancelled' : 'error';
                this.view.error = safeError(job.abort.signal.aborted ? job.abort.signal.reason : e, [config.advanced.key]);
            }
        } finally {
            clearTimeout(timer); release();
            if (this.active === job) { this.active = undefined; this.view.totalMs = Math.round(performance.now() - started); this.publish(); }
        }
        return this.snapshot();
    }
}
