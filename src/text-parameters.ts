// These fields are owned by the app's single, text-only request structure.
const reserved = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'functions', 'function_call', 'n', 'modalities', 'audio']);
export function textParameters(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('预设参数必须是 JSON 对象');
    for (const key of Object.keys(value)) if (reserved.has(key)) throw new Error(`预设参数不能覆盖 ${key}`);
    if (JSON.stringify(value).length > 8000) throw new Error('预设参数过长');
    return structuredClone(value) as Record<string, unknown>;
}
