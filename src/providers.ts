import { RequestController } from './requests.js';
import { ApiFailure, readFailureBody, type ErrorHeaders } from './api-errors.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fetch as request, ProxyAgent } from 'undici';
import type { Config, VoiceConfig, VoiceDone, TextConfig } from './types.js';
import { advancedAvailability } from './runtime.js';
import { textParameters } from './text-parameters.js';
import { normalizeRealtimeURL, normalizeChatURL, assertRealtimeModel } from './endpoints.js';
export function safeError(error: unknown, secrets: string[] = []) { let s = error instanceof Error ? error.message : String(error); for (const x of secrets)
    if (x)
        s = s.split(x).join('[已隐藏]'); return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[已隐藏]').slice(0, 1200); }
export function voiceURL(c: VoiceConfig) { if (!c.key || !c.model || !c.url)
    throw new Error('请先填写实时语音 API Key、模型和地址'); assertRealtimeModel(c.model); const u = new URL(normalizeRealtimeURL(c.url)); u.searchParams.set('model', c.model); return u.toString(); }
export interface VoiceOptions {
    role: 'gate' | 'reply' | 'speaker' | 'high' | 'transcribe';
    lane?: 'low' | 'high';
    config: VoiceConfig;
    appConfig: Config;
    instructions: string;
    requests?: RequestController;
}
export class Realtime extends EventEmitter {
    socket?: WebSocket;
    ready = false;
    active = false;
    private heartbeat?: ReturnType<typeof setInterval>;
    private texts = new Map<string, string>();
    private dead = false;
    private sessionSent = false;
    private configured = false;
    private configuredInstructions = '';
    private pendingText?: {
        id: string;
        text: string;
        timer: ReturnType<typeof setTimeout>;
    };
    private clearText() { if (this.pendingText)
        clearTimeout(this.pendingText.timer); this.pendingText = undefined; }
    private pendingReject?: (err: Error) => void;
    constructor(public options: VoiceOptions) { super(); }
    async connect() {
        if (this.dead || this.socket)
            throw new Error('该语音会话已连接或已经结束');
        const url = voiceURL(this.options.config), proxy = this.options.appConfig.proxy;
        const finishRequest = this.options.requests?.voice({ url, model: this.options.config.model, source: 'voice-' + this.options.role, channel: 'voice' });
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { finish(new Error('实时语音连接超时，请检查地址、密钥、网络或代理')); this.close(); }, 20000);
            const finish = (err?: Error) => { clearTimeout(timer); this.pendingReject = undefined; if (err)
                reject(err);
            else
                resolve(); };
            this.pendingReject = err => finish(err);
            let socket: WebSocket;
            try {
                socket = this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.options.config.key}` }, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}), handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
            }
            catch (e) {
                finishRequest?.('failed');
                finish(new Error(safeError(e, [this.options.config.key])));
                return;
            }
            socket.on('open', () => { finishRequest?.('connected'); this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN)
                socket.ping(); }, 20000); });
            socket.on('message', (data) => {
                if (this.dead)
                    return;
                let e: any;
                try {
                    e = JSON.parse(data.toString());
                }
                catch {
                    return;
                }
                if (['session.updated', 'conversation.item.created'].includes(e.type))
                    this.options.requests?.protocol({ url: this.options.config.url, model: this.options.config.model, source: 'voice-' + this.options.role, channel: 'voice' }, e.type, 'received');
                if (e.type === 'session.created' && !this.sessionSent) {
                    this.sessionSent = true;
                    this.configure(this.options.instructions);
                }
                if (e.type === 'session.updated' && !this.ready) {
                    this.ready = true;
                    finish();
                    this.emit('ready');
                }
                if (e.type === 'conversation.item.created' && this.pendingText) {
                    const p = this.pendingText, item = e.item;
                    if (item?.role === 'user' && (item.id === p.id || item.content?.some((c: any) => c.type === 'input_text' && c.text === p.text))) {
                        this.clearText();
                        this.respond();
                    }
                }
                if (e.type === 'error') {
                    this.clearText();
                    this.active = false;
                    const error = new Error(safeError([e.error?.code, e.error?.message || e.message || '实时接口错误'].filter(Boolean).join(': '), [this.options.config.key]));
                    if (!this.ready)
                        finish(error);
                    this.emit('fault', error);
                    return;
                }
                if (e.type === 'input_audio_buffer.speech_started')
                    this.emit('speech', e);
                if (e.type === 'input_audio_buffer.speech_stopped')
                    this.emit('speechEnd', e);
                if (e.type === 'conversation.item.input_audio_transcription.completed')
                    this.emit('transcript', e.transcript || '');
                if (e.type === 'response.created') {
                    this.active = true;
                    this.emit('responseStart', e.response?.id);
                }
                if (e.type === 'response.text.delta' || e.type === 'response.audio_transcript.delta') {
                    const id = e.response_id || '';
                    this.texts.set(id, (this.texts.get(id) || '') + (e.delta || ''));
                    this.emit('textDelta', { id, text: e.delta || '' });
                }
                if (e.type === 'response.audio.delta' && !['gate','transcribe'].includes(this.options.role))
                    this.emit('audio', { id: e.response_id || '', itemId: e.item_id, audio: e.delta });
                if (e.type === 'response.done') {
                    this.active = false;
                    const r = e.response || {};
                    const output = r.output || [];
                    const text = output.flatMap((x: any) => x.content || []).map((x: any) => x.text || x.transcript || '').join('') || this.texts.get(r.id) || '';
                    this.texts.delete(r.id);
                    const done: VoiceDone = { id: r.id || randomUUID(), status: r.status || 'completed', text, output, usage: r.usage, ...(r.status_details?.error ? { error: safeError(r.status_details.error.message || JSON.stringify(r.status_details.error), [this.options.config.key]) } : {}) };
                    this.emit('usage', { role: this.options.role, model: this.options.config.model, usage: r.usage || {} });
                    this.emit('done', done);
                }
            });
            socket.on('error', (e) => { finishRequest?.('failed', Number(String(e).match(/Unexpected server response: (\d{3})/)?.[1]) || undefined); const err = new Error(safeError(e, [this.options.config.key])); if (!this.ready)
                finish(err); if (!this.dead) this.emit('fault', err); });
            socket.on('close', (code) => { finishRequest?.('closed-before-open'); clearTimeout(timer); if (this.heartbeat)
                clearInterval(this.heartbeat); const wasReady = this.ready; this.ready = false; if (!wasReady)
                finish(new Error(`实时连接关闭 (${code})`)); if (!this.dead)
                this.emit('disconnected', code); });
        });
    }
    configure(instructions: string) {
        this.options.instructions = instructions;
        if (this.configured) {
            if (instructions === this.configuredInstructions)
                return;
            this.configuredInstructions = instructions;
            this.send({ type: 'session.update', session: { instructions } });
            return;
        }
        this.configured = true;
        this.configuredInstructions = instructions;
        const { role, config, appConfig } = this.options;
        this.send({ type: 'session.update', session: { modalities: ['gate','transcribe'].includes(role) ? ['text'] : ['text', 'audio'],
                voice: config.voice, audio: { input: { format: { type: 'pcm', sample_rate: 16000 } }, output: { format: { type: 'pcm', sample_rate: 24000 }, voice: config.voice } },
                input_audio_transcription: role === 'transcribe' ? { model: 'qwen3-asr-flash-realtime' } : null, instructions,
                turn_detection: role !== 'gate' ? null : { type: appConfig.vad.type, threshold: appConfig.vad.threshold, silence_duration_ms: appConfig.vad.silenceMs },
                max_tokens: role === 'gate' ? 1800 : 2500 } });
    }
    send(event: any) { if (this.socket?.readyState === WebSocket.OPEN) {
        this.options.requests?.protocol({ url: this.options.config.url, model: this.options.config.model, source: 'voice-' + this.options.role, channel: 'voice' }, event.type, 'sent');
        this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    } }
    append(audio: string) { if (this.ready && this.socket!.bufferedAmount < 1024 * 1024)
        this.send({ type: 'input_audio_buffer.append', audio });
    else if (this.ready)
        this.emit('backpressure'); }
    text(text: string) { if (!this.ready || this.dead)
        throw new Error('语音连接尚未就绪'); if (this.pendingText || this.active)
        throw new Error('上一条语音请求尚未结束'); const id = 'item_' + randomUUID().replaceAll('-', ''); const timer = setTimeout(() => { this.clearText(); this.emit('fault', new Error('服务端未确认文本输入，本轮未发送生成请求')); }, 10000); this.pendingText = { id, text, timer }; this.send({ type: 'conversation.item.create', item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }); }
    finishInput() { if (this.options.role !== 'transcribe' || !this.ready || this.dead) throw new Error('转写尚未就绪'); this.send({ type: 'input_audio_buffer.commit' }); }
    toolResult(callId: string, output: string, respond = false) { this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } }); if (respond)
        this.respond(); }
    respond() { this.send({ type: 'response.create' }); }
    cancel() { if (this.active) {
        this.send({ type: 'response.cancel' });
        this.active = false;
    } }
    close() { this.clearText(); this.dead = true; this.ready = false; if (this.heartbeat)
        clearInterval(this.heartbeat); this.pendingReject?.(new Error('连接已结束')); this.pendingReject = undefined; if (this.socket) {
        if (this.socket.readyState === WebSocket.CONNECTING)
            this.socket.terminate();
        else
            this.socket.close();
    } }
}
export async function postJSON(url: string, key: string, body: unknown, proxy: string, signal: AbortSignal, timeoutMs = 120000, onDelta?: (text: string) => void): Promise<any> {
    const agent = proxy ? new ProxyAgent(proxy) : undefined;
    try {
        const res = await request(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), ...(agent ? { dispatcher: agent } : {}) });
        if (!res.ok)
            throw new ApiFailure(res.status, await readFailureBody(res.body), res.headers, [key]);
        if (res.headers.get('content-type')?.includes('text/event-stream'))
            return await readChatStream(res.body, signal, { secrets: [key], headers: res.headers }, onDelta);
        const data: any = await res.json();
        if (data?.error)
            throw new ApiFailure(undefined, data, res.headers, [key]);
        return data;
    }
    finally {
        await agent?.close();
    }
}
// Aggregate SSE chunks, including UTF-8 characters split across packets,
// usage-only final frames and incrementally streamed tool arguments.
export async function readChatStream(body: AsyncIterable<Uint8Array> | null, signal: AbortSignal, diagnostic: {
    secrets?: string[];
    headers?: ErrorHeaders;
} = {}, onDelta?: (text: string) => void) {
    if (!body)
        throw new Error('文字接口未返回响应体');
    const decoder = new TextDecoder();
    let pending = '', text = '', usage: any, finished = false, done = false, finishReason: string | undefined;
    const calls = new Map<number, any>();
    let bytes = 0;
    const frame = (block: string) => {
        signal.throwIfAborted();
        if (done) return;
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data)
            return;
        if (data.trim() === '[DONE]') {
            done = true;
            return;
        }
        let x: any;
        try {
            x = JSON.parse(data);
        }
        catch {
            throw new Error('文字流式接口返回了无效 JSON');
        }
        if (x.error)
            throw new ApiFailure(undefined, x, diagnostic.headers, diagnostic.secrets);
        if (x.usage)
            usage = x.usage;
        const choice = x.choices?.find((c: any) => c.index === 0) || x.choices?.[0];
        if (!choice)
            return;
        if (choice.finish_reason) { finished = true; finishReason = choice.finish_reason; }
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') { text += delta.content; onDelta?.(delta.content); }
        for (const t of delta.tool_calls || []) {
            const index = t.index ?? 0;
            let call = calls.get(index);
            if (!call) {
                call = { id: '', type: 'function', function: { name: '', arguments: '' } };
                calls.set(index, call);
            }
            if (t.id)
                call.id = t.id;
            if (t.type)
                call.type = t.type;
            if (t.function?.name)
                call.function.name += t.function.name;
            if (t.function?.arguments)
                call.function.arguments += t.function.arguments;
        }
    };
    for await (const chunk of body) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024)
            throw new Error('文字响应超过本应用的大小限制');
        pending += decoder.decode(chunk, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(pending))) {
            frame(pending.slice(0, separator.index));
            pending = pending.slice(separator.index + separator[0].length);
        }
    }
    pending += decoder.decode();
    if (pending.trim())
        frame(pending);
    signal.throwIfAborted();
    if (!done && !finished)
        throw new Error('文字流式响应提前中断，未将残缺内容作为完整结果');
    const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    if (tool_calls.some(c => !c.id || !c.function.name))
        throw new Error('流式工具调用不完整');
    return { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) } }], ...(usage ? { usage } : {}) };
}
export class TextModel {
    private requests: RequestController;
    constructor(private app: Config, private onUsage: (usage: any) => void = () => { }, private scope: {
        requests?: RequestController;
        source?: string;
        taskId?: string;
        manual?: boolean;
    } = {}) { this.requests = scope.requests || new RequestController(() => ({ origin: app.advanced.url, limit: app.advanced.requestsPerMinute ?? 8 })); }
    async complete(messages: any[], signal: AbortSignal, options: { parameters?: Record<string, unknown>; onDelta?: (text: string) => void } = {}): Promise<string> {
        const c = this.app.advanced;
        const availability = advancedAvailability(this.app);
        if (this.scope.manual ? availability.missing.length > 0 : availability.state !== 'configured')
            throw new Error(this.scope.manual ? `请先填写并保存文字接口：缺少${availability.missing.join('、')}` : availability.message);
        signal.throwIfAborted();
        const streaming = c.stream !== false, url = normalizeChatURL(c.url);
        const parameters = options.parameters ? textParameters(options.parameters) : {};
        const r = await this.requests.run({ url, model: c.model, source: this.scope.source || 'advanced-task', channel: 'advanced', taskId: this.scope.taskId, round: 1, limit: c.requestsPerMinute ?? 8 }, signal, () => postJSON(url, c.key, { max_tokens: 1800, ...parameters, model: c.model, messages, stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}), ...(/^qwen3\.8-omni-flash$/.test(c.model) ? { modalities: ['text'] } : {}) }, this.app.proxy, signal, this.app.taskTimeoutSeconds * 1000, options.onDelta), !!this.scope.manual);
        signal.throwIfAborted();
        this.onUsage({ role: 'advanced', model: c.model, usage: r.usage || {} });
        const m = r.choices?.[0]?.message;
        if (this.scope.manual && r.choices?.[0]?.finish_reason && r.choices[0].finish_reason !== 'stop') throw new Error('文字输出未完整完成：' + r.choices[0].finish_reason);
        if (typeof m?.content !== 'string' || !m.content.trim())
            throw new Error('文字接口未返回有效文字');
        return m.content;
    }
}
