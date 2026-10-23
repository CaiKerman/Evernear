import { EventEmitter } from 'node:events';
// One active text job across voice delegation, quick input and manual helpers.
// Cancellation invalidates ownership immediately; late cleanup cannot free a newer job.
export class TextWork extends EventEmitter {
    private current?: { source: string; abort: AbortController };
    get source() { return this.current?.abort.signal.aborted ? undefined : this.current?.source; }
    claim(source: string, abort: AbortController) {
        if (this.source) throw new Error(`文字任务忙：${this.source}。请取消已有任务或稍后再提交。`);
        abort.signal.throwIfAborted();
        const job = this.current = { source, abort };
        const changed = () => { if (this.current === job) this.emit('change'); };
        abort.signal.addEventListener('abort', changed, { once: true });
        this.emit('change');
        return () => { abort.signal.removeEventListener('abort', changed); if (this.current === job) { this.current = undefined; this.emit('change'); } };
    }
    cancel() { this.current?.abort.abort(new Error('用户取消文字任务')); }
}
