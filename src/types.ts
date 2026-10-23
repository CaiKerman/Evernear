export type Mode = 'ambient' | 'high';
export type VoiceProvider = 'qwen' | 'openai' | 'gemini' | 'doubao';
export interface VoiceConfig {
    url: string;
    key: string;
    model: string;
    voice: string;
    provider?: VoiceProvider | 'inherit';
    appId?: string;
    appKey?: string;
    resourceId?: string;
}
export interface TextConfig {
    enabled: boolean;
    url: string;
    key: string;
    model: string;
    stream?: boolean;
    requestsPerMinute?: number;
}
export interface VoicePrices {
    textInput: number | null;
    audioInput: number | null;
    textOutput: number | null;
    audioOutput: number | null;
}
export interface Config {
    version: 1;
    low: VoiceConfig;
    high: VoiceConfig;
    advanced: TextConfig;
    quickInput: QuickInputConfig;
    proxy: string;
    microphone: string;
    outputDevice: string;
    sensitivity: 'conservative' | 'balanced' | 'active';
    vad: {
        type: 'semantic_vad' | 'server_vad';
        threshold: number;
        silenceMs: number;
    };
    contextChars: number;
    recentTurns: number;
    rotateMinutes: number;
    taskTimeoutSeconds: number;
    recordHistory: boolean;
    pricingVersion: 2;
    prices: VoicePrices;
    highPrices: VoicePrices;
    advancedPrices: {
        input: number | null;
        output: number | null;
    };
}
export type QuickPreset = 'translate' | 'polish' | 'answer';
export interface QuickInputConfig {
    visible: boolean;
    preset: QuickPreset;
    context: boolean;
    parameters: Record<QuickPreset, Record<string, unknown>>;
    position?: { x: number; y: number };
}
export interface Turn {
    id: string;
    at: string;
    role: 'user' | 'assistant';
    text: string;
    lane: string;
    delivery?: 'generated' | 'heard' | 'partial' | 'unheard';
    heardMs?: number;
    durationMs?: number;
    deliveryReason?: string;
    taskId?: string;
}
export interface MemoryEntry {
    id: string;
    text: string;
    tags: string[];
    source: string;
    createdAt: string;
    updatedAt: string;
}
export interface Task {
    id: string;
    query: string;
    status: 'running' | 'done' | 'cancelled' | 'failed';
    startedAt: string;
    finishedAt?: string;
    result?: string;
    error?: string;
}
export interface Session {
    version: 1;
    summary: string;
    summaryThrough?: string;
    turns: Turn[];
    tasks: Task[];
}
export interface Decision {
    action: 'ignore' | 'answer' | 'delegate' | 'ambient' | 'switch_high' | 'cancel' | 'remember' | 'recall' | 'capabilities';
    utterance: string;
    reason: string;
    query?: string;
    memory?: string;
    replaceTaskId?: string;
}
export interface ContextPacket {
    purpose: string;
    query: string;
    instructions: string;
    memory: string[];
    summary: string;
    turns: Pick<Turn, 'role' | 'at' | 'text'>[];
    tasks: Pick<Task, 'id' | 'query' | 'status'>[];
    runtime?: Record<string, unknown>;
    text: string;
    chars: number;
    limit: number;
}
export interface AppEvent {
    type: string;
    [key: string]: any;
}
export interface VoiceDone {
    id: string;
    status: string;
    text: string;
    output: any[];
    usage?: any;
    error?: string;
}
export interface Snapshot {
    config: Config;
    memoryText: string;
    instructions: string;
    session: Session;
    folder: string;
    advancedStatus?: {
        state: string;
        message: string;
    };
    billing?: import('./billing.js').BillingSnapshot;
    requests?: ReturnType<import('./requests.js').RequestController['snapshot']>;
}
