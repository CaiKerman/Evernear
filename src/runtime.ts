import type { Config } from './types.js';
export function advancedAvailability(config: Config) {
    const c = config.advanced;
    const missing = ([['url', '地址'], ['key', 'API Key'], ['model', '模型']] as const).filter(([key]) => !c[key].trim()).map(([, label]) => label);
    const state = !c.enabled ? 'disabled' : missing.length ? 'incomplete' : 'configured';
    const message = state === 'disabled' ? (missing.length ? '高级文字：未启用。' : '高级文字：接口已填写，但“启用高级文字推理”开关关闭。') :
        state === 'incomplete' ? `高级文字：已勾选启用，但缺少${missing.join('、')}。` : `高级文字：已保存启用，模型 ${c.model}。实际调用结果见任务状态。`;
    return { state, model: c.model, message, missing };
}
// Only count provider-reported usage. Silent audio and in-flight requests may not
// yet have usage reports, so this is explicitly not a continuous billing meter.
export class UsageMeter {
    private since?: number;
    private roles: Record<string, {
        calls: number;
        inputTokens: number;
        outputTokens: number;
    }> = {};
    reset(now = Date.now()) { this.since = now; this.roles = {}; }
    record(role: string, usage: any, now = Date.now()) {
        if (!['gate', 'reply', 'speaker', 'high', 'advanced'].includes(role) || !usage || typeof usage !== 'object')
            return;
        const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
        if (![input, output].some(n => typeof n === 'number' && Number.isFinite(n) && n >= 0))
            return;
        if (this.since === undefined)
            this.since = now;
        const row = this.roles[role] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
        row.calls++;
        if (typeof input === 'number' && Number.isFinite(input) && input >= 0)
            row.inputTokens += input;
        if (typeof output === 'number' && Number.isFinite(output) && output >= 0)
            row.outputTokens += output;
    }
    snapshot(now = Date.now()) {
        return { since: this.since === undefined ? null : new Date(this.since).toISOString(), elapsedSeconds: this.since === undefined ? 0 : Math.max(0, Math.round((now - this.since) / 1000)),
            byRole: structuredClone(this.roles), note: '本次开始倾听后的供应商已报告用量，单位为词元；未完成请求可能尚未计入。按时长外推仅为粗估，不是账单；输入和输出须分别按用户给出的单价计算。没有足够观测时应追问，不能编造速率。' };
    }
}
